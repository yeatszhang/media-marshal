// M0 验证守护：父管道断开后仍有独立机会回收两个 Go 服务，不依赖 Electron 退出回调。
package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

type configuration struct {
	Root   string            `json:"root"`
	Native map[string]string `json:"native"`
}

type child struct {
	cmd  *exec.Cmd
	done chan struct{}
}

func main() {
	output := json.NewEncoder(os.Stdout)
	failure := func(stage string) {
		_ = output.Encode(map[string]any{"kind": "failure", "component": "guardian", "reason": "守护初始化失败：" + stage})
	}
	closeJob, err := ownJob()
	if err != nil {
		failure("进程所有权（" + err.Error() + "）")
		os.Exit(1)
	}
	defer closeJob()
	var config configuration
	decoder := json.NewDecoder(os.Stdin)
	if decoder.Decode(&config) != nil || !filepath.IsAbs(config.Root) {
		failure("配置输入")
		os.Exit(1)
	}
	if len(os.Args) != 2 || os.Args[1] != "--fixture-root="+config.Root {
		failure("执行标识")
		os.Exit(1)
	}
	children := []*child{}
	exited := make(chan struct{}, 2)
	stop := func() {
		for _, c := range children {
			_ = c.cmd.Process.Signal(syscall.SIGTERM)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		for _, c := range children {
			select {
			case <-c.done:
			case <-ctx.Done():
			}
			_ = c.cmd.Process.Kill()
		}
		for _, c := range children {
			<-c.done
		}
	}
	defer stop()
	start := func(name string, args ...string) bool {
		binary := config.Native[name]
		if !filepath.IsAbs(binary) {
			failure(name + " 资源路径")
			return false
		}
		cmd := exec.Command(binary, args...)
		cmd.Dir = config.Root
		configureChild(cmd)
		if cmd.Start() != nil {
			failure(name + " 启动")
			return false
		}
		c := &child{cmd: cmd, done: make(chan struct{})}
		children = append(children, c)
		_ = output.Encode(map[string]any{"kind": "native-started", "name": name, "pid": cmd.Process.Pid})
		go func() {
			_ = cmd.Wait()
			_ = output.Encode(map[string]any{"kind": "native-exited", "name": name, "code": cmd.ProcessState.ExitCode()})
			close(c.done)
			exited <- struct{}{}
		}()
		return true
	}
	if !start("openlist", "--data", filepath.Join(config.Root, "openlist"), "--config", filepath.Join(config.Root, "openlist/config.json"), "server") {
		return
	}
	if !start("rclone", "copy", filepath.Join(config.Root, "source"), filepath.Join(config.Root, "staging"), "--config", filepath.Join(config.Root, "rclone.conf"), "--local-no-clone", "--bwlimit", "128k", "--transfers", "1", "--multi-thread-streams", "1") {
		return
	}
	eof := make(chan struct{})
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); close(eof) }()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	select {
	case <-eof:
	case <-signals:
	case <-exited:
	}
}

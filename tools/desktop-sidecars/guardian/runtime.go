package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type runtimeRequest struct {
	Type        string            `json:"type"`
	RequestID   string            `json:"requestId"`
	ExecutionID string            `json:"executionId"`
	Program     string            `json:"program"`
	Args        []string          `json:"args"`
	Environment map[string]string `json:"environment"`
}

type runtimeLog struct {
	id   string
	emit func(map[string]any)
}

func (writer runtimeLog) Write(data []byte) (int, error) {
	for start := 0; start < len(data); start += 16 * 1024 {
		end := min(start+16*1024, len(data))
		writer.emit(map[string]any{"kind": "stderr", "executionId": writer.id, "encoding": "base64", "data": base64.StdEncoding.EncodeToString(data[start:end])})
	}
	return len(data), nil
}

// 此私有协议只执行已核验的两个程序；不搜索 PATH，不使用 shell，不把原始服务日志落盘。
func runRuntime(config configuration, decoder *json.Decoder, output func(map[string]any)) {
	control := make(chan map[string]any, 256)
	logs := make(chan map[string]any, 64)
	fatal := make(chan struct{}, 1)
	emit := func(event map[string]any) {
		select {
		case control <- event:
		default:
			select {
			case fatal <- struct{}{}:
			default:
			}
		}
	}
	// 原始传输统计允许丢弃；关闭父连接时不能因日志背压阻塞进程回收。
	log := func(event map[string]any) {
		select {
		case logs <- event:
		default:
		}
	}
	go func() {
		for {
			select {
			case event := <-control:
				output(event)
			default:
				select {
				case event := <-control:
					output(event)
				case event := <-logs:
					output(event)
				}
			}
		}
	}()
	for _, name := range []string{"openlist", "rclone"} {
		if !filepath.IsAbs(config.Native[name]) {
			return
		}
	}
	requests := make(chan runtimeRequest, 64)
	parentGone := make(chan struct{})
	go func() {
		defer close(parentGone)
		scanner := bufio.NewScanner(io.MultiReader(decoder.Buffered(), os.Stdin))
		scanner.Buffer(make([]byte, 4096), 64*1024)
		for scanner.Scan() {
			if strings.TrimSpace(scanner.Text()) == "" {
				continue
			}
			var request runtimeRequest
			input := json.NewDecoder(strings.NewReader(scanner.Text()))
			input.DisallowUnknownFields()
			if input.Decode(&request) != nil {
				return
			}
			select {
			case requests <- request:
			case <-fatal:
				return
			}
		}
	}()
	children := make(map[string]*child)
	stop := func(list []*child) {
		for _, entry := range list {
			_ = entry.cmd.Process.Signal(syscall.SIGTERM)
		}
		deadline := time.NewTimer(2 * time.Second)
		defer deadline.Stop()
		for _, entry := range list {
			select {
			case <-entry.done:
			case <-deadline.C:
				for _, pending := range list {
					_ = pending.cmd.Process.Kill()
				}
				goto wait
			}
		}
	wait:
		for _, entry := range list {
			<-entry.done
		}
	}
	all := func() []*child {
		values := make([]*child, 0, len(children))
		for _, entry := range children {
			values = append(values, entry)
		}
		return values
	}
	defer func() { stop(all()) }()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	heartbeat := time.Now()
	emit(map[string]any{"kind": "ready"})
	for {
		select {
		case <-parentGone:
			return
		case <-fatal:
			return
		case <-signals:
			return
		case <-ticker.C:
			if time.Since(heartbeat) > 10*time.Second {
				return
			}
		case request := <-requests:
			if request.Type == "heartbeat" {
				heartbeat = time.Now()
				continue
			}
			failure := func() {
				emit(map[string]any{"kind": "error", "requestId": request.RequestID, "code": "INVALID_EXECUTION"})
			}
			switch request.Type {
			case "start":
				if len(request.RequestID) != 36 || len(request.ExecutionID) != 36 || (request.Program != "openlist" && request.Program != "rclone") || len(request.Args) > 128 || len(children) >= 4096 {
					failure()
					continue
				}
				if _, exists := children[request.ExecutionID]; exists {
					failure()
					continue
				}
				valid := true
				for _, argument := range request.Args {
					if len(argument) > 4096 || strings.ContainsRune(argument, 0) {
						valid = false
					}
				}
				for key, value := range request.Environment {
					if request.Program != "openlist" || key != "OPENLIST_ADMIN_PASSWORD" || len(value) > 256 {
						valid = false
					}
				}
				if !valid {
					failure()
					continue
				}
				command := exec.Command(config.Native[request.Program], request.Args...)
				command.Dir = config.Root
				command.Env = os.Environ()
				for key, value := range request.Environment {
					command.Env = append(command.Env, key+"="+value)
				}
				configureChild(command)
				if request.Program == "rclone" {
					command.Stderr = runtimeLog{id: request.ExecutionID, emit: log}
				}
				if command.Start() != nil {
					failure()
					continue
				}
				command.Env = nil
				entry := &child{cmd: command, done: make(chan struct{})}
				children[request.ExecutionID] = entry
				emit(map[string]any{"kind": "started", "requestId": request.RequestID, "executionId": request.ExecutionID, "program": request.Program, "pid": command.Process.Pid})
				go func(id string, current *child) {
					_ = current.cmd.Wait()
					close(current.done)
					code := current.cmd.ProcessState.ExitCode()
					emit(map[string]any{"kind": "exited", "executionId": id, "code": code})
				}(request.ExecutionID, entry)
			case "stop":
				entry, exists := children[request.ExecutionID]
				if !exists {
					failure()
					continue
				}
				stop([]*child{entry})
				emit(map[string]any{"kind": "stopped", "requestId": request.RequestID, "executionId": request.ExecutionID})
			case "stop-all":
				stop(all())
				emit(map[string]any{"kind": "stopped-all", "requestId": request.RequestID})
			default:
				failure()
			}
		}
	}
}

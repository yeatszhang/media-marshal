//go:build !windows

package main

import (
	"os/exec"
	"os/signal"
	"syscall"
)

func ownJob() (func(), error) {
	syscall.Umask(0o077)
	// 父进程关闭读取管道时仍须完成清理，不能被日志输出的 SIGPIPE 提前终止。
	signal.Ignore(syscall.SIGPIPE)
	return func() {}, nil
}
func configureChild(cmd *exec.Cmd) {}

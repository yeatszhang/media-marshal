//go:build !windows

package main

import "os/exec"

func ownJob() (func(), error)      { return func() {}, nil }
func configureChild(cmd *exec.Cmd) {}

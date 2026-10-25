package main

import (
	"fmt"
	"os/exec"
	"syscall"
	"unsafe"
)

type basicLimits struct {
	ProcessTime     int64
	JobTime         int64
	Flags           uint32
	MinWorkingSet   uintptr
	MaxWorkingSet   uintptr
	ActiveProcesses uint32
	Affinity        uintptr
	Priority        uint32
	Scheduling      uint32
}

type extendedLimits struct {
	Basic             basicLimits
	IO                [6]uint64
	ProcessMemory     uintptr
	JobMemory         uintptr
	PeakProcessMemory uintptr
	PeakJobMemory     uintptr
}

func ownJob() (func(), error) {
	kernel := syscall.NewLazyDLL("kernel32.dll")
	handle, _, err := kernel.NewProc("CreateJobObjectW").Call(0, 0)
	if handle == 0 {
		return nil, fmt.Errorf("CreateJobObjectW: %w", err)
	}
	close := func() { _ = syscall.CloseHandle(syscall.Handle(handle)) }
	limits := extendedLimits{}
	limits.Basic.Flags = 0x2000 // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	ok, _, err := kernel.NewProc("SetInformationJobObject").Call(handle, 9, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits))
	if ok == 0 {
		close()
		return nil, fmt.Errorf("SetInformationJobObject: %w", err)
	}
	current, _, _ := kernel.NewProc("GetCurrentProcess").Call()
	ok, _, err = kernel.NewProc("AssignProcessToJobObject").Call(handle, current)
	if ok == 0 {
		close()
		return nil, fmt.Errorf("AssignProcessToJobObject: %w", err)
	}
	// 先把守护自身放进 Job，再启动任何子进程，避免启动与加入 Job 之间的空窗。
	return close, nil
}

func configureChild(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000} }

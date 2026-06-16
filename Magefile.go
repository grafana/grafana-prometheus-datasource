//go:build mage
// +build mage

package main

import (
	build "github.com/grafana/grafana-plugin-sdk-go/build"
	"github.com/magefile/mage/mg"
	"github.com/magefile/mage/sh"
)

// Default configures the default target.
var Default = BuildAll

// BuildAll builds all default targets plus linux/s390x and windows/arm64,
// to support bundling with Grafana builds on those platforms. This overrides
// the buildAll from grafana-plugin-sdk-go.
func BuildAll() {
	b := build.Build{}
	mg.Deps(b.Linux, b.Windows, b.Darwin, b.DarwinARM64, b.LinuxARM64, b.LinuxARM, LinuxS390X, WindowsARM64)
}

// LinuxS390X builds the back-end plugin for Linux on s390x (IBM Z).
func LinuxS390X() error {
	return build.Build{}.Custom("linux", "s390x")
}

// WindowsARM64 builds the back-end plugin for Windows on arm64.
func WindowsARM64() error {
	return build.Build{}.Custom("windows", "arm64")
}

// Test() wraps the plugin SDK's Test to make it accessible since we're
// no longer using mage:import
func Test() error {
	if err := build.Test(); err != nil {
		return err
	}
	// pkg/promlib has its own go.mod, so ./pkg/... in the root module stops at the module
	// boundary and never reaches it. Run its tests explicitly as a separate module.
	return sh.RunV("go", "test", "-C", "./pkg/promlib", "./...")
}

// TestRace() wraps the plugin SDK's Test to make it accessible since we're
// no longer using mage:import
func TestRace() error {
	if err := build.TestRace(); err != nil {
		return err
	}
	// pkg/promlib has its own go.mod, so ./pkg/... in the root module stops at the module
	// boundary and never reaches it. Run its tests explicitly as a separate module.
	return sh.RunV("go", "test", "-race", "-C", "./pkg/promlib", "./...")
}

func Debugger() error {
	return build.Debugger()
}

func ReloadPlugin() error {
	return build.ReloadPlugin()
}

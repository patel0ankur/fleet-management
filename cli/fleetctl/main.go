package main

import (
	"fmt"
	"os"

	"github.com/openchoreo-aws/fleet-management/cli/fleetctl/cmd"
)

func main() {
	if err := cmd.NewRootCmd().Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "fleetctl:", err)
		os.Exit(1)
	}
}

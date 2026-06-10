package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

// Version is overridden at link time via -ldflags.
var Version = "0.1.0"

func newVersionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print fleetctl version",
		RunE: func(cmd *cobra.Command, args []string) error {
			fmt.Printf("fleetctl %s\n", Version)
			return nil
		},
	}
}

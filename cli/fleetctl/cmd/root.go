package cmd

import (
	"github.com/spf13/cobra"
)

// NewRootCmd builds the top-level fleetctl command.
func NewRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:           "fleetctl",
		Short:         "Operate Fleet Management — self-hosted IDP for AWS",
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	root.PersistentFlags().StringP("config", "c", "config/platform.yaml", "path to platform.yaml")

	root.AddCommand(
		newInitCmd(),
		newDeployCmd(),
		newStatusCmd(),
		newVersionCmd(),
	)
	return root
}

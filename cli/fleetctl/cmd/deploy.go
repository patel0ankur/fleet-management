package cmd

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/openchoreo-aws/fleet-management/cli/fleetctl/internal/config"
	"github.com/spf13/cobra"
)

func newDeployCmd() *cobra.Command {
	var skipBootstrap bool
	cmd := &cobra.Command{
		Use:   "deploy",
		Short: "Run cdk bootstrap and deploy all Fleet stacks",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfgPath, _ := cmd.Flags().GetString("config")
			c, err := config.Load(cfgPath)
			if err != nil {
				return err
			}
			fmt.Printf("==> Deploying Fleet '%s' (org=%s) to account %s in %s\n",
				c.Metadata.Name, c.Metadata.Org, c.Spec.AWS.SharedServicesAccount, c.Spec.AWS.Region)

			if !skipBootstrap {
				fmt.Println("==> cdk bootstrap")
				if err := runStreaming("npx", "cdk", "bootstrap",
					fmt.Sprintf("aws://%s/%s", c.Spec.AWS.SharedServicesAccount, c.Spec.AWS.Region),
					"--context", "configFile="+cfgPath,
				); err != nil {
					return err
				}
			}

			fmt.Println("==> cdk deploy --all")
			return runStreaming("npx", "cdk", "deploy", "--all",
				"--require-approval", "never",
				"--context", "configFile="+cfgPath,
			)
		},
	}
	cmd.Flags().BoolVar(&skipBootstrap, "skip-bootstrap", false, "skip `cdk bootstrap`")
	return cmd
}

func runStreaming(name string, args ...string) error {
	c := exec.Command(name, args...)
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	c.Stdin = os.Stdin
	return c.Run()
}

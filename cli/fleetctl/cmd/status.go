package cmd

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"

	"github.com/openchoreo-aws/fleet-management/cli/fleetctl/internal/config"
	"github.com/spf13/cobra"
)

func newStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Print Fleet stack + cluster health",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfgPath, _ := cmd.Flags().GetString("config")
			c, err := config.Load(cfgPath)
			if err != nil {
				return err
			}
			prefix := "fleet-" + c.Metadata.Name

			fmt.Println("==> CloudFormation stacks")
			for _, s := range []string{prefix + "-bootstrap", prefix + "-platform"} {
				st, err := stackStatus(s, c.Spec.AWS.Region)
				if err != nil {
					fmt.Printf("  ✗ %-40s %v\n", s, err)
					continue
				}
				fmt.Printf("  · %-40s %s\n", s, st)
			}

			fmt.Println()
			fmt.Println("==> EKS")
			if out, err := exec.Command("kubectl", "get", "nodes", "--no-headers").CombinedOutput(); err != nil {
				fmt.Printf("  ✗ kubectl get nodes failed: %s\n", strings.TrimSpace(string(out)))
			} else {
				lines := strings.Split(strings.TrimSpace(string(out)), "\n")
				fmt.Printf("  · %d nodes\n", len(lines))
			}

			fmt.Println()
			fmt.Println("==> ArgoCD")
			if out, err := exec.Command("kubectl", "-n", "argocd", "get", "pods", "--no-headers").CombinedOutput(); err != nil {
				fmt.Printf("  ✗ %s\n", strings.TrimSpace(string(out)))
			} else {
				running := 0
				total := 0
				for _, l := range strings.Split(strings.TrimSpace(string(out)), "\n") {
					if l == "" {
						continue
					}
					total++
					if strings.Contains(l, "Running") {
						running++
					}
				}
				fmt.Printf("  · %d/%d pods running\n", running, total)
			}

			return nil
		},
	}
}

func stackStatus(name, region string) (string, error) {
	out, err := exec.Command("aws", "cloudformation", "describe-stacks",
		"--stack-name", name,
		"--region", region,
		"--query", "Stacks[0].StackStatus",
		"--output", "json",
	).Output()
	if err != nil {
		return "", err
	}
	var s string
	if err := json.Unmarshal(out, &s); err != nil {
		return "", err
	}
	return s, nil
}

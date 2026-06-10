package cmd

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/openchoreo-aws/fleet-management/cli/fleetctl/internal/config"
	"github.com/spf13/cobra"
)

func newInitCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "init",
		Short: "Verify prereqs and scaffold config/platform.yaml",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfgPath, _ := cmd.Flags().GetString("config")

			fmt.Println("==> Tool checks")
			if err := runToolChecks(); err != nil {
				return err
			}

			fmt.Println()
			fmt.Println("==> Config scaffolding")
			if _, err := os.Stat(cfgPath); err == nil {
				fmt.Printf("  · %s already exists, skipping copy\n", cfgPath)
			} else {
				examplePath := filepath.Join(filepath.Dir(cfgPath), "platform.example.yaml")
				if err := copyFile(examplePath, cfgPath); err != nil {
					return fmt.Errorf("copy example: %w", err)
				}
				fmt.Printf("  ✓ wrote %s\n", cfgPath)
				if err := substituteCallerArn(cfgPath); err != nil {
					fmt.Printf("  · could not auto-fill adminPrincipalArns: %v\n", err)
				} else {
					fmt.Printf("  ✓ pre-filled spec.eks.adminPrincipalArns with caller identity\n")
				}
				fmt.Printf("  edit %s (account id, region, gitops repo, IdC instance/group) then run: fleetctl deploy\n", cfgPath)
				return nil
			}

			fmt.Println()
			fmt.Println("==> Validating", cfgPath)
			if _, err := config.Load(cfgPath); err != nil {
				return err
			}
			fmt.Println("  ✓ config is valid")
			return nil
		},
	}
	return cmd
}

func runToolChecks() error {
	required := []string{"node", "npm", "npx", "aws", "kubectl", "helm"}
	missing := []string{}
	for _, t := range required {
		if _, err := exec.LookPath(t); err != nil {
			missing = append(missing, t)
			fmt.Printf("  ✗ %s (missing)\n", t)
		} else {
			fmt.Printf("  ✓ %s\n", t)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("missing tools: %v", missing)
	}
	if err := exec.Command("aws", "sts", "get-caller-identity").Run(); err != nil {
		return fmt.Errorf("aws credentials not configured (run `aws configure`)")
	}
	fmt.Println("  ✓ aws credentials present")
	return nil
}

// substituteCallerArn replaces the example placeholder ARN with the caller's
// real identity (so the platform engineer running `fleetctl init` doesn't
// have to look up their own ARN).
func substituteCallerArn(cfgPath string) error {
	out, err := exec.Command("aws", "sts", "get-caller-identity", "--query", "Arn", "--output", "text").Output()
	if err != nil {
		return fmt.Errorf("aws sts get-caller-identity: %w", err)
	}
	arn := strings.TrimSpace(string(out))
	if arn == "" {
		return fmt.Errorf("empty caller ARN")
	}
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		return err
	}
	updated := strings.Replace(
		string(raw),
		"arn:aws:iam::111111111111:role/PlatformEngineer",
		arn,
		1,
	)
	if updated == string(raw) {
		return fmt.Errorf("placeholder ARN not found in %s", cfgPath)
	}
	return os.WriteFile(cfgPath, []byte(updated), 0o644)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

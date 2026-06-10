// Package config provides minimal YAML loading + sanity checks for platform.yaml.
// Full schema validation lives in the TS loader; the CLI only does the bare
// minimum needed for `fleetctl init` and friendly error reporting.
package config

import (
	"fmt"
	"os"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

type PlatformConfig struct {
	APIVersion string `yaml:"apiVersion"`
	Kind       string `yaml:"kind"`
	Metadata   struct {
		Name string `yaml:"name"`
		Org  string `yaml:"org"`
	} `yaml:"metadata"`
	Spec struct {
		AWS struct {
			SharedServicesAccount string `yaml:"sharedServicesAccount"`
			Region                string `yaml:"region"`
		} `yaml:"aws"`
		EKS struct {
			Name               string   `yaml:"name"`
			Version            string   `yaml:"version"`
			AdminPrincipalArns []string `yaml:"adminPrincipalArns"`
		} `yaml:"eks"`
		Identity struct {
			IDC struct {
				InstanceArn  string `yaml:"instanceArn"`
				AdminGroupID string `yaml:"adminGroupId"`
			} `yaml:"idc"`
		} `yaml:"identity"`
		GitOps struct {
			RepoURL string `yaml:"repoUrl"`
		} `yaml:"gitops"`
	} `yaml:"spec"`
}

var (
	nameRe    = regexp.MustCompile(`^[a-z][a-z0-9-]{1,40}$`)
	orgRe     = regexp.MustCompile(`^[a-z][a-z0-9-]{1,30}$`)
	accountRe = regexp.MustCompile(`^[0-9]{12}$`)
	regionRe  = regexp.MustCompile(`^[a-z]{2}-[a-z]+-[0-9]$`)
)

func Load(path string) (*PlatformConfig, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	var c PlatformConfig
	if err := yaml.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	return &c, nil
}

func (c *PlatformConfig) Validate() error {
	if c.APIVersion != "fleet.platform/v1" {
		return fmt.Errorf("apiVersion must be fleet.platform/v1, got %q", c.APIVersion)
	}
	if c.Kind != "PlatformConfig" {
		return fmt.Errorf("kind must be PlatformConfig, got %q", c.Kind)
	}
	if !nameRe.MatchString(c.Metadata.Name) {
		return fmt.Errorf("metadata.name %q invalid (must match %s)", c.Metadata.Name, nameRe)
	}
	if !orgRe.MatchString(c.Metadata.Org) {
		return fmt.Errorf("metadata.org %q invalid (must match %s)", c.Metadata.Org, orgRe)
	}
	if !accountRe.MatchString(c.Spec.AWS.SharedServicesAccount) {
		return fmt.Errorf("spec.aws.sharedServicesAccount must be a 12-digit account id")
	}
	if !regionRe.MatchString(c.Spec.AWS.Region) {
		return fmt.Errorf("spec.aws.region %q invalid", c.Spec.AWS.Region)
	}
	if c.Spec.GitOps.RepoURL == "" {
		return fmt.Errorf("spec.gitops.repoUrl is required")
	}
	if c.Spec.AWS.SharedServicesAccount == "111111111111" {
		return fmt.Errorf("spec.aws.sharedServicesAccount is the placeholder \"111111111111\"; replace it before deploy")
	}
	if c.Spec.Identity.IDC.InstanceArn == "" || strings.Contains(c.Spec.Identity.IDC.InstanceArn, "XXXX") {
		return fmt.Errorf("spec.identity.idc.instanceArn is empty or a placeholder; run `aws sso-admin list-instances` and paste the InstanceArn")
	}
	if c.Spec.Identity.IDC.AdminGroupID == "" || c.Spec.Identity.IDC.AdminGroupID == "00000000-0000-0000-0000-000000000000" {
		return fmt.Errorf("spec.identity.idc.adminGroupId is empty or a placeholder; pick an IdC group/user that should get Argo CD ADMIN")
	}
	if len(c.Spec.EKS.AdminPrincipalArns) == 0 {
		return fmt.Errorf("spec.eks.adminPrincipalArns is empty; add the IAM role/user ARN that will run deploys (else kubectl returns 401)")
	}
	for _, arn := range c.Spec.EKS.AdminPrincipalArns {
		if strings.HasPrefix(arn, "arn:aws:iam::111111111111:") {
			return fmt.Errorf("spec.eks.adminPrincipalArns contains the example ARN %q; replace it", arn)
		}
	}
	return nil
}

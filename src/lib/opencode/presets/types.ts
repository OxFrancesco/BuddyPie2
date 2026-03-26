export type OpenCodeSkillPermission = 'allow' | 'ask' | 'deny'

export type OpenCodeManagedSkill = {
  id: string
  name: string
  description: string
  content: string
  permission?: OpenCodeSkillPermission
}

export type OpenCodeManagedMcp = {
  command: string
  args?: Array<string>
  env?: Array<string>
}

export type OpenCodeDocsWorkspaceBootstrap = {
  kind: 'fumadocs-docs-app'
  sourceRepoUrl: string
  sourceRepoBranch: string
  sourceRepoPath: string
  docsTemplate: 'tanstack-start'
  preferredDocsPath: string
  fallbackDocsPath: string
  packageManager: 'bun' | 'npm'
}

export type OpenCodeWorkspaceBootstrap = OpenCodeDocsWorkspaceBootstrap

export type OpenCodeModelOptionDefinition = {
  id: string
  label: string
  description: string
  provider: string
  providerLabel: string
  model: string
  modelLabel: string
  requiredEnv: Array<string>
}

export type OpenCodeAgentPresetDefinition = {
  id: string
  label: string
  description: string
  repositoryOptional?: boolean
  defaultModelOptionId: string
  provider: string
  model: string
  requiredEnv: Array<string>
  agentPrompt: string
  instructionsMd: string
  starterPrompt: string
  starterPromptPlaceholder: string
  skills: Array<OpenCodeManagedSkill>
  mcp: Record<string, OpenCodeManagedMcp>
  workspaceBootstrap?: OpenCodeWorkspaceBootstrap
}

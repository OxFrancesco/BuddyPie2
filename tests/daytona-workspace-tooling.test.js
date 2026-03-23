import { describe, expect, test } from 'bun:test'
import { getOpenCodeAgentPreset } from '../src/lib/opencode/presets.ts'
import { buildManagedSandboxToolingInstallCommand } from '../src/lib/server/daytona/workspace.ts'

describe('buildManagedSandboxToolingInstallCommand', () => {
  test('installs the default managed tooling with bun first and npm fallback', () => {
    const command = buildManagedSandboxToolingInstallCommand(
      getOpenCodeAgentPreset('general-engineer'),
    )

    expect(command).toContain('export PATH="$HOME/.bun/bin:$HOME/.npm-global/bin:$PATH"')
    expect(command).toContain('NPM_GLOBAL_PREFIX="$HOME/.npm-global"')
    expect(command).toContain('mkdir -p "$NPM_GLOBAL_PREFIX/bin"')
    expect(command).toContain('if [ -n "$BUN_BIN" ]; then')
    expect(command).toContain('if ! "$BUN_BIN" add -g \'opencode-ai@1.2.26\'; then')
    expect(command).toContain(
      '"$NPM_BIN" install -g --prefix "$NPM_GLOBAL_PREFIX" \'opencode-ai@1.2.26\'',
    )
    expect(command).not.toContain('nansen-cli')
    expect(command).not.toContain('skills add')
  })

  test('adds the nansen cli and skill package for the nansen preset', () => {
    const command = buildManagedSandboxToolingInstallCommand(
      getOpenCodeAgentPreset('nansen-analyst'),
    )

    expect(command).toContain(
      '"$NPM_BIN" install -g --prefix "$NPM_GLOBAL_PREFIX" \'opencode-ai@1.2.26\'',
    )
    expect(command).toContain(
      '"$NPM_BIN" install -g --prefix "$NPM_GLOBAL_PREFIX" \'nansen-cli@1.20.0\'',
    )
    expect(command).toContain(
      '"$NPX_BIN" --yes skills add \'nansen-ai/nansen-cli\'',
    )
  })
})

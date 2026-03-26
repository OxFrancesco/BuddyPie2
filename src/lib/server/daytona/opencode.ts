import type { Sandbox } from '@daytonaio/sdk'
import type { OpenCodeAgentPreset } from '~/lib/opencode/presets'
import { buildOpenCodeConfig } from './launch-config'
import {
  getCommandStdout,
  injectEnvVar,
  OPENCODE_PORT,
  parseSeededSessionPayload,
  quoteShellArg,
  READY_TIMEOUT_MS,
  SEEDED_SESSION_PAYLOAD_MARKER,
  summarizeCommandOutput,
  type ExecuteCommandResponse,
  type LaunchEnvironment,
} from './shared'

export async function startOpencodeWeb(args: {
  sandbox: Sandbox
  workspacePath: string
  preset: OpenCodeAgentPreset
  launchEnvironment: LaunchEnvironment
}): Promise<{ previewUrl: string; previewUrlPattern: string }> {
  const previewLink = await args.sandbox.getPreviewLink(OPENCODE_PORT)
  const previewUrlPattern = (
    await args.sandbox.getPreviewLink(1234)
  ).url.replace(/1234/, '{PORT}')
  const opencodeConfig = buildOpenCodeConfig(args.preset, previewUrlPattern)
  const sessionId = `opencode-web-${Date.now()}`
  const envVars = [
    injectEnvVar('OPENCODE_CONFIG_CONTENT', opencodeConfig),
    injectEnvVar('OPENCODE_DISABLE_CLAUDE_CODE', '1'),
    ...Object.entries(args.launchEnvironment).map(([name, value]) =>
      injectEnvVar(name, value),
    ),
  ].join(' ')

  await args.sandbox.process.createSession(sessionId)
  const startCommand = `
set -e
cd ${quoteShellArg(args.workspacePath)}
export PATH="$HOME/.bun/bin:$HOME/.npm-global/bin:$PATH"

OPENCODE_BIN=$(command -v opencode || true)

if [ -z "$OPENCODE_BIN" ] && [ -x "$HOME/.bun/bin/opencode" ]; then
  OPENCODE_BIN="$HOME/.bun/bin/opencode"
fi

if [ -z "$OPENCODE_BIN" ] && [ -x "$HOME/.npm-global/bin/opencode" ]; then
  OPENCODE_BIN="$HOME/.npm-global/bin/opencode"
fi

if [ -z "$OPENCODE_BIN" ]; then
  echo "OpenCode is not installed in the sandbox."
  exit 1
fi

${envVars} "$OPENCODE_BIN" web --port ${OPENCODE_PORT}
`.trim()
  const command = await args.sandbox.process.executeSessionCommand(sessionId, {
    command: startCommand,
    runAsync: true,
  })

  if (!command.cmdId) {
    throw new Error('Failed to start OpenCode inside the sandbox.')
  }

  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (!settled) {
        settled = true
        resolve()
      }
    }

    void args.sandbox.process.getSessionCommandLogs(
      sessionId,
      command.cmdId,
      (stdout) => {
        if (
          stdout.includes(`127.0.0.1:${OPENCODE_PORT}`) ||
          stdout.includes('Web interface:')
        ) {
          finish()
        }
      },
      () => {},
    )

    setTimeout(finish, READY_TIMEOUT_MS)
  })

  return {
    previewUrl: previewLink.url,
    previewUrlPattern,
  }
}

export async function seedInitialPrompt(args: {
  sandbox: Sandbox
  workspacePath: string
  repoName: string
  preset: OpenCodeAgentPreset
  initialPrompt: string
}) {
  const seedScript = `
;(async () => {
  const baseUrl = 'http://127.0.0.1:${OPENCODE_PORT}'
  const initialPrompt = process.env.BUDDYPIE_INITIAL_PROMPT?.trim() ?? ''
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const waitForApi = async () => {
    const timeoutAt = Date.now() + 45_000

    while (Date.now() < timeoutAt) {
      try {
        const response = await fetch(\`\${baseUrl}/session/status\`)
        if (response.ok) {
          return
        }
      } catch {}

      await wait(750)
    }

    throw new Error('OpenCode API did not become ready in time.')
  }
  const waitForAssistantMessage = async (sessionId) => {
    if (!initialPrompt) {
      return
    }

    const timeoutAt = Date.now() + 15_000

    while (Date.now() < timeoutAt) {
      const response = await fetch(
        \`\${baseUrl}/session/\${sessionId}/message?limit=20\`,
      )

      if (response.ok) {
        const messages = await response.json()
        const assistant = Array.isArray(messages)
          ? messages.find((message) => message?.info?.role === 'assistant')
          : undefined

        if (assistant?.info?.error) {
          const detail =
            assistant.info.error.message ||
            assistant.info.error.data?.message ||
            JSON.stringify(assistant.info.error)
          throw new Error(\`OpenCode prompt failed: \${detail}\`)
        }

        if (assistant) {
          return
        }
      }

      await wait(500)
    }
  }

  await waitForApi()

  const sessionResponse = await fetch(\`\${baseUrl}/session\`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: process.env.BUDDYPIE_SESSION_TITLE }),
  })
  if (!sessionResponse.ok) {
    throw new Error(\`OpenCode session creation failed: \${sessionResponse.status} \${await sessionResponse.text()}\`)
  }
  const session = await sessionResponse.json()

  if (initialPrompt) {
    const promptResponse = await fetch(\`\${baseUrl}/session/\${session.id}/prompt_async\`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: process.env.BUDDYPIE_AGENT_ID,
        parts: [{ type: 'text', text: initialPrompt }],
      }),
    })
    if (!promptResponse.ok && promptResponse.status !== 204) {
      throw new Error(\`OpenCode prompt injection failed: \${promptResponse.status} \${await promptResponse.text()}\`)
    }

    await waitForAssistantMessage(session.id)
  }

  process.stdout.write('${SEEDED_SESSION_PAYLOAD_MARKER}' + JSON.stringify({ sessionId: session.id }))
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
`.trim()
  const response = (await args.sandbox.process.executeCommand(
    `node -e ${quoteShellArg(seedScript)}`,
    args.workspacePath,
    {
      BUDDYPIE_AGENT_ID: args.preset.id,
      BUDDYPIE_INITIAL_PROMPT: args.initialPrompt,
      BUDDYPIE_SESSION_TITLE: `${args.repoName} - ${args.preset.label}`,
    },
    90,
  )) as ExecuteCommandResponse
  const stdout = getCommandStdout(response).trim()

  if (response.exitCode !== undefined && response.exitCode !== 0) {
    throw new Error(
      `OpenCode prompt seeding failed: ${summarizeCommandOutput(stdout)}`,
    )
  }

  if (!stdout) {
    throw new Error('OpenCode did not return a seeded session id.')
  }

  const payload = parseSeededSessionPayload(stdout)

  if (!payload.sessionId) {
    throw new Error('OpenCode did not create a valid seeded session.')
  }

  return payload.sessionId
}

export async function sendPromptToExistingSession(args: {
  sandbox: Sandbox
  workspacePath: string
  preset: OpenCodeAgentPreset
  sessionId: string
  prompt: string
}) {
  const promptScript = `
;(async () => {
  const baseUrl = 'http://127.0.0.1:${OPENCODE_PORT}'
  const sessionId = process.env.BUDDYPIE_SESSION_ID?.trim() ?? ''
  const prompt = process.env.BUDDYPIE_PROMPT ?? ''
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const waitForApi = async () => {
    const timeoutAt = Date.now() + 20_000

    while (Date.now() < timeoutAt) {
      try {
        const response = await fetch(\`\${baseUrl}/session/status\`)
        if (response.ok) {
          return
        }
      } catch {}

      await wait(500)
    }

    throw new Error('OpenCode API did not become ready in time.')
  }

  if (!sessionId) {
    throw new Error('OpenCode session id is missing.')
  }

  if (!prompt.trim()) {
    throw new Error('OpenCode prompt is empty.')
  }

  await waitForApi()

  const promptResponse = await fetch(\`\${baseUrl}/session/\${sessionId}/prompt_async\`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agent: process.env.BUDDYPIE_AGENT_ID,
      parts: [{ type: 'text', text: prompt }],
    }),
  })

  if (!promptResponse.ok && promptResponse.status !== 204) {
    throw new Error(\`OpenCode prompt injection failed: \${promptResponse.status} \${await promptResponse.text()}\`)
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
`.trim()
  const response = (await args.sandbox.process.executeCommand(
    `node -e ${quoteShellArg(promptScript)}`,
    args.workspacePath,
    {
      BUDDYPIE_AGENT_ID: args.preset.id,
      BUDDYPIE_SESSION_ID: args.sessionId,
      BUDDYPIE_PROMPT: args.prompt,
    },
    60,
  )) as ExecuteCommandResponse
  const stdout = getCommandStdout(response).trim()

  if (response.exitCode !== undefined && response.exitCode !== 0) {
    throw new Error(
      `OpenCode prompt injection failed: ${summarizeCommandOutput(stdout)}`,
    )
  }
}

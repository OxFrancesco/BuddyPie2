const sharedDeliveryAgentPrompt =
  'Use Bun for Node and TypeScript repo commands. BuddyPie provisions repositories onto a dedicated working branch before the session starts, so stay on that branch and do not switch back to the base branch unless the user explicitly asks. Do not wait for a follow-up prompt before finishing delivery. Before handoff, run the relevant build command, run the relevant typecheck command or the closest repo validation that covers types, fix any failures introduced by your work, and when GitHub auth is available in the sandbox, commit and push the current branch so a PR can be opened from that branch.'

const sharedDeliveryInstructionsMd = `
## Required Delivery Workflow

- Use Bun for Node and TypeScript repo commands in this workspace.
- BuddyPie already moved the repo onto a dedicated working branch before this session started. Stay on that branch and do not switch back to the base branch unless the user explicitly asks.
- Do not wait for a follow-up prompt before finishing delivery for the initial request.
- Before handoff, run the relevant build command for the repo or affected package.
- Run the relevant typecheck command for the repo or affected package. If there is no dedicated typecheck script, run the closest repo validation command that covers types.
- Fix any failures introduced by your changes before handing work back.
- When GitHub auth is available in the sandbox, commit and push the current branch so a PR can be opened from that branch.
`.trim()

export function withSharedDeliveryPrompt(prompt: string) {
  return `${prompt} ${sharedDeliveryAgentPrompt}`
}

export function withSharedDeliveryInstructions(instructionsMd: string) {
  return `${instructionsMd.trim()}\n\n${sharedDeliveryInstructionsMd}`
}

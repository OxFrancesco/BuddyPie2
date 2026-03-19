# Delegated Budget Contract Notes

`BuddyPieDelegatedBudgetSettlement` now treats the smart account as the only onchain authority.
The backend delegate address is stored for auditability, but direct settlement from that EOA is rejected.
Periodic `month` budgets use a fixed 30-day interval so contract behavior matches the toolkit's
second-based ERC-20 periodic spend scopes.

## Required Environment Variables

- `DEPLOYER_PRIVATE_KEY`: deployer key used by `forge script`
- `BUDDYPIE_TREASURY`: treasury that receives USDC
- `BUDDYPIE_USDC`: USDC token address for the target network

Recommended RPC URLs:

- Base Sepolia: `https://sepolia.base.org`
- Base Mainnet: `https://mainnet.base.org`

Known USDC addresses:

- Base Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
- Base Mainnet: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

## Deploy

Base Sepolia:

```bash
forge script contracts/script/DeployDelegatedBudgetBaseSepolia.s.sol:DeployDelegatedBudgetBaseSepolia \
  --rpc-url https://sepolia.base.org \
  --broadcast
```

Base Mainnet:

```bash
forge script contracts/script/DeployDelegatedBudgetBaseMainnet.s.sol:DeployDelegatedBudgetBaseMainnet \
  --rpc-url https://mainnet.base.org \
  --broadcast
```

If you want BaseScan verification, add `--verify --etherscan-api-key "$ETHERSCAN_API_KEY"` to either command.

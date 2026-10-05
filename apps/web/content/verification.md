In Solana program development there is an ability where you can verify your program builds. This means you generate a deterministic proof that the program on chain was built from your publicly committed code (a byte code replica). This is important because without it programs on chain can differ from what they claim to be or what an audit stamp may back.

> Verified builds ensure that your deployed program matches exactly with your public source code, promoting transparency and security in the Solana ecosystem.
>
> — [solana-verifiable-build README](https://github.com/solana-foundation/solana-verifiable-build)

Since getting into Solana program development and watching what actually gets deployed (look for yourself: [on-record.azuolas.xyz](https://on-record.azuolas.xyz/)), I've had trouble understanding why verified builds are so uncommon. In this article I will outline why that seems to be the case using on-chain data, and how to simplify your process to reliably verify your builds when deploying/upgrading your programs.

## 1 in 40 Solana programs has a verified build.

Currently 2.5% of all programs live on Solana are verified builds. On Sep 28, 21,770 programs were live on Solana's upgradeable loader. 547 of them had a verified build.

![Every live upgradeable program on Solana, each dot about 22 programs](/verification/grid.png 1660x1326)

### Verified builds are rarer than other things teams choose to publish.

Of the 21,770 programs live on mainnet, verified builds are the least used option to communicate what a program is.

- 1 in 7 publishes an IDL (14.2%)
- 1 in 20 has a security.txt (4.8%)
- 1 in 40 has a verified build (2.5%)

IDLs are like a program's menu: "here are the instructions I have and these are the accounts I take". Apps and explorers use them to talk to the program and read their transactions. A security.txt says who to contact about a bug, and sometimes links the source code, kind of like a LinkTree for your program. A verified build is the only one of the three that someone else checks. It proves the program running on chain was built from one exact public commit. So you can read the code that's actually running, and an audit of that commit applies to what's deployed.

## Shipping: verified vs unverified builds

The lack of verified program builds comes down to the development process. Most teams choose not to publish verified builds, and I think it comes down to the additional overhead when shipping.

### Shipping verified builds is more work, both to set up and to keep up.

Generally teams build and test on devnet, then deploy to mainnet with real SOL. If their programs are mutable (97% are), then the upgrade authority (the key that signs upgrades) determines your development process. Careful teams put that key in a Squads multisig, which turns every on-chain step into a proposal that several signers have to approve. 8% of live programs today use a Squads v4 multisig as the upgrade authority for their programs.

### Everyone has to compile through the same Docker image.

Solana only stores your build: the byte code your code compiles into. The same code can compile to different bytes on different computers, so the [Solana Foundation has a CLI tool](https://github.com/solana-foundation/solana-verifiable-build) that downloads a Docker image with every tool version fixed and builds your program inside it. Builds from this image can be verified. A build from your own machine can't, and has to be rebuilt and redeployed.

### Solana holds the recipe. One company holds the result.

The "recipe" is what I'm calling a small PDA account on Solana holding the build parameters: the repo, the exact commit, and the build settings, written by your upgrade authority. That signature requirement exists because of Accretion ([@accretion_xyz](https://x.com/accretion_xyz)): [they showed](https://accretion.xyz/blog/verified-builds) that anyone could attach their own repo to a program they didn't control and still get the verified badge, and the fix was making the upgrade authority sign the recipe.

To be verified, the exact commit you deployed has to be public and the recipe has to be on chain. With a multisig, writing it is another proposal. A server that [@osec_io](https://x.com/osec_io) maintains watches [Otter Verify](https://explorer.solana.com/address/verifycLy8mB96wd9wqq3WDXQwM4oU6r42Th37Db9fC) (a Solana program) for new recipes, rebuilds the program from the linked commit and compares the bytes. If they match, it's labelled verified. If not, it silently fails. The result lives in OtterSec's database, and explorers read it from there.

### An unverified deploy is three steps. A verified deploy is a minimum of five.

![Who does each step: a normal deploy vs a verified deploy](/verification/lanes.png 1660x1664)

## Many programs that try to verify builds lose it

Of the 717 live programs with a recipe on chain, 174 aren't verified. That's 1 in 4.

### Most failures come from upgrades.

106 of the 174 live programs that failed build verification are failing because a new recipe was never written for the new version. A verified build covers one exact version of a program, so an upgrade takes the badge away. [Orca's Whirlpool](/p/whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc) was verified on Feb 4, upgraded on Aug 19, and hasn't been rebuilt since. Of the rest, 27 have a recipe OtterSec never built, 17 point to a repo or commit that's gone, and 24 were rebuilt but didn't match.

### Multisig teams verify the most and lose the badge the most.

Squads v4 ([@multisig](https://x.com/multisig)) programs are about 6× more likely to be verified than single-wallet ones, but they're also 38% of the failures, and 54 of their 66 failures are upgrades that were never re-verified. After an upgrade, OtterSec re-checks automatically only if a new recipe is on chain within about 5 minutes; after that, the team has to post a request manually. For a multisig the new recipe is another proposal, and my guess is those rarely get approved in 5 minutes.

### Verified builds fail silently.

Nothing tells a team when an upgrade removes the badge, or how a rebuild OtterSec started on its own turned out. Neither the [@solana_devs](https://x.com/solana_devs) verify CLI nor OtterSec's server has any way to notify a team, and OtterSec's status gives no reason, only "On chain program not verified". So broken builds stay broken until someone notices. Going back through the upgrades On Record has recorded, 33 broke a verified build, the earliest on July 10. The five that were re-verified got there within about 40 minutes, most likely by posting a manual request after the window closed. The other 28 never did, Whirlpool among them since Aug 19. When it's done inside the window, it's nearly instant: [@ORE](https://x.com/ORE) upgraded at 23:08 UTC on Sep 25 and was verified again by 23:12.

## How to verify your builds faster

- **Get your recipe on chain within 5 minutes of every upgrade.**
  This one change covers the biggest cause of failure: inside the window, OtterSec re-checks by itself.
- **If you use a multisig, use the Foundation's workflow or export the recipe yourself.**
  The Foundation's [github-workflows](https://github.com/solana-foundation/github-workflows) put the upgrade and the recipe in one Squads proposal. Without it, the CLI can export the recipe as a Squads transaction without building anything, so the signers can approve both in the same sitting.
- **Check your program after every upgrade.**
  [On Record's program page](/) and `onrecord verify` (a [CLI tool I'm building](https://github.com/0xmigi/On-Record)) can tell you why a build isn't verified and what to run.
- **Build in the Docker image from your first mainnet deploy.**
  It's slower on a Mac, but it saves a redeploy later.
- **Keep the deployed commit public, with Cargo.lock at the root.**
- **Name your Solana version in your Cargo.toml.**
  The CLI picks the Docker image from the `[workspace.metadata.cli]` section first, and otherwise guesses from your dependencies. This matters most for Pinocchio programs and programs on the newer Solana SDK ([@anza_xyz](https://x.com/anza_xyz)).

## Verified builds as part of the deploy process

### In EVM land, the bytecode points to its recipe and verifying is a flag on deploy.

The [Solidity compiler](https://docs.soliditylang.org/en/latest/metadata.html) embeds a fingerprint of the build recipe in every contract's bytecode (an IPFS hash of the metadata file: the ABI, compiler version, settings and source files). Then [Sourcify](https://sourcify.dev/) pins these files on IPFS for the contracts verified through it. [Foundry's](https://getfoundry.sh/forge/reference/forge-verify-contract/) `forge create --verify` deploys and verifies in one command, and developers can choose Etherscan, Sourcify or Blockscout to check it.

The bigger difference is that an EVM contract's code never changes. An upgrade there means deploying a new contract, which gets verified as it's deployed. A Solana upgrade replaces the bytes in place, so the old verification lapses, and 97% of live Solana programs can be upgraded this way.

![The verified deploy today vs the same deploy with one flag](/verification/proposed.png 1660x1756)

### Solana already has this, it's just hidden in CI.

The Solana Foundation's own [github-workflows](https://github.com/solana-foundation/github-workflows) build in the Docker image, upload the IDL, and bundle the upgrade, the IDL and the recipe into one Squads transaction with one approval, and OtterSec's rebuild starts automatically once it executes. The Foundation [moved its own mainnet releases](https://github.com/solana-foundation/dvp/pull/12) to this single combined transaction on Sep 28. [The action behind it](https://github.com/solana-foundation/squads-program-action) has 3 stars on GitHub. Putting the same flow behind a flag on `anchor deploy` or `solana program deploy` would put it in front of the teams that need it.

### Teams could be notified when a build breaks.

On Record already records when an upgrade breaks a verified build, and which upgrade did it. Notifications you could subscribe to for your own program don't exist yet but could easily be built on top of this data.

### Commit evidence could be kept permanently, and checked by more than one party.

Repos get deleted or made private, and Solana only keeps the latest version of a program. A blob storage archive ([@tapedrive_io](https://x.com/tapedrive_io)) could keep every version: the program, the code, the recipe and the result. Storage built for this kind of public record is close. [OtterSec's checker is open source](https://github.com/otter-sec/solana-verified-programs-api), so with that archive, "verified" could mean several independent checkers agree instead of one company's database.

Without a verified build, your audit covers code nobody can prove is running. A verified build is the only link between the code you advertise and the program on chain.

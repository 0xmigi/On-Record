import { SectionExplainer } from "@/components/SectionExplainer";

/**
 * "What's a throwaway bot?" — the educational section behind the churn figure.
 * Explains the deploy → spam → close → redeploy loop, why traders run it, and
 * how On Record detects it. Reused on the Stats page and on a bot's dossier.
 */
export function BotExplainer() {
  return (
    <SectionExplainer title="What's a throwaway bot?">
      <p className="explainer-read">
        A disposable on-chain program a trader deploys to run one strategy —
        almost always sniping new Pump.fun token launches — then closes minutes
        later to reclaim its rent, redeploying under a fresh id for the next run.
      </p>

      <h4 className="explainer-h">Why a program at all?</h4>
      <p>
        Sniping means &quot;buy the instant the pool exists, atomically, or
        abort&quot; — you can&apos;t do that reliably from a wallet. A tiny
        custom program bundles the whole attempt (and often multi-venue routing)
        into a single instruction that either lands complete or reverts.
      </p>

      <h4 className="explainer-h">Why thousands of failed transactions?</h4>
      <p>
        That&apos;s the race. The bot fires on every launch; most attempts lose
        the block or the token rugs, so they revert. The failures{" "}
        <em>are</em> the strategy — spray for the few that land.
      </p>

      <h4 className="explainer-h">Why redeploy and close?</h4>
      <p>
        The ~0.2 SOL of rent is refundable on close, and a fresh program id
        sidesteps any blocklist or reputation built against a known address.
        Cheaper and stealthier to burn identities than to keep one — so one
        operator can wear dozens of &quot;new program&quot; identities in a day.
      </p>

      <h4 className="explainer-h">How On Record catches it</h4>
      <p>
        Exact-bytecode dedup (same sha256 = same bot) collapses the redeploys
        into one cluster; lifecycle tracking sees the deploy → close; the
        failed-tx count confirms the intent. No explorer distinguishes &quot;new
        protocol&quot; from &quot;same bot, 30th identity today&quot; — that&apos;s
        a novelty-definition problem, which is exactly what this radar solves.
      </p>
    </SectionExplainer>
  );
}

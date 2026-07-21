
/**
 * Governance Policy (SDK mode)
 * Policies are enforced locally at the platform level.
 * Import this into your LuaAgent config.
 */

export const governance = {
  mode: 'sdk' as const,

  /**
   * Scan incoming messages for prompt injection before they reach the agent.
   *
   * This agent reads untrusted text from strangers on WhatsApp and can move
   * money, so the input surface is genuinely hostile. Threshold is set tight
   * rather than permissive — a false positive costs one re-phrased message,
   * a false negative costs a customer's cash.
   */
  injection: {
    threshold: 0.7,
  },

  rules: {
    /**
     * Charging a customer requires explicit approval before the tool runs.
     *
     * Everything else in this agent is reversible. An STK Push is not — once
     * the prompt is on someone's phone, the cheapest outcome is confusion and
     * the worst is a real debit. This is the one tool worth a hard stop.
     */
    requireApproval: ['request_mpesa_payment'],

    /**
     * Ceiling on tokens per conversation. WhatsApp ordering turns are short;
     * a runaway loop here is a cost bug, not a feature.
     */
    tokenBudget: 100_000,
  },
};
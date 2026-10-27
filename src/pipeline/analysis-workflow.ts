import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

// The analysis pipeline for one case (D00 T01 §5: the binding and a no-op step; the steps arrive with D02 onwards).
export type AnalysisParams = { caseId: string };

export class AnalysisWorkflow extends WorkflowEntrypoint<Env, AnalysisParams> {
  async run(event: WorkflowEvent<AnalysisParams>, step: WorkflowStep) {
    return step.do("accept", async () => ({ caseId: event.payload.caseId }));
  }
}

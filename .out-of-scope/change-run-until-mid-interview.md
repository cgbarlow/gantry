# Changing "Run until" while an interview is running

An AI interview's **Run until** (the last Stage one interview drafts) is chosen on the kickoff screen and stays fixed for that interview. Gantry does not offer a way to widen or narrow it once the interview has started, in the app or over MCP.

## Why this is out of scope

It is a convenience with a lossless way round it. An architect who started with "this Stage only" and wants to carry on finishes the Stage with **Save and finish the run**, then starts a new interview with Run until set to a later Stage. Nothing is lost: the saved Stage, the decisions log and the Source documents carry over, and the new run drafts each later Stage in order as usual. An architect who wants to change the target before saving anything uses **Start this stage over**, which returns to the kickoff where Run until is offered again.

Changing the target mid-run would touch the stage-end card (carry on or finish), the paused-run record, draft-ahead on Azure DevOps and GitHub (ADR-0063), and the MCP session tools (ADR-0067). That is a lot of moving parts to save one click, so the product owner chose not to build it.

## Prior requests

- #327: "Change Run until while an interview is running"

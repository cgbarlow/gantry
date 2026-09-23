// Terse, numbered, imperative "protocol" style (matching Iris's own MCP server, per docs/adr/0043) —
// model behavior stays predictable without per-call hand-holding.
export const SERVER_INSTRUCTIONS = `
1. This server is a thin client of one running gantry serve instance — it has no data of its own.
2. Every workspace- or instance-scoped tool takes a workspace or instance id you got from a prior list_workspaces / list_instances call. Do not guess ids.
3. A tool call that fails with "missing_workspace_pat" means the operator needs to add that workspace to this server's GANTRY_MCP_WORKSPACE_PATS — you cannot fix this yourself; report it back to the operator verbatim.
4. A tool call that fails with "authentication_required" means gantry serve rejected the credential this server already sent — report the message back to the operator; do not retry with a guessed credential.
5. Every mutating or irreversible tool (advance_stage, publish_definition_version, archive_workspace, etc.) is named for exactly what it does. There is no generic "call any endpoint" tool and no confirmation step inside this server — treat each such call as final once made.
`.trim()

export const SH_TEMPLATE = `#!/bin/sh
# thomas shim — auto-generated, do not edit
# agent: __AGENT_ID__
__THOMAS_INVOCATION__ proxy ensure --port __PORT__ >/dev/null 2>&1 || true
__SHIM_ENV_BLOCK__
exec "__ORIGINAL__" "$@"
`;

export const CMD_TEMPLATE = `@echo off
rem thomas shim -- auto-generated, do not edit
rem agent: __AGENT_ID__
__THOMAS_INVOCATION__ proxy ensure --port __PORT__ >nul 2>&1
__SHIM_ENV_BLOCK__
"__ORIGINAL__" %*
`;

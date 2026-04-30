export const SH_TEMPLATE = `#!/bin/sh
# thomas shim — auto-generated, do not edit
# agent: __AGENT_ID__
__THOMAS_INVOCATION__ proxy ensure --port __PORT__ >/dev/null 2>&1 || true
export __BASE_URL_VAR__="http://127.0.0.1:__PORT____BASE_URL_PATH__"
export __API_KEY_VAR__="__TOKEN__"
exec "__ORIGINAL__" "$@"
`;

export const CMD_TEMPLATE = `@echo off
rem thomas shim -- auto-generated, do not edit
rem agent: __AGENT_ID__
__THOMAS_INVOCATION__ proxy ensure --port __PORT__ >nul 2>&1
set "__BASE_URL_VAR__=http://127.0.0.1:__PORT____BASE_URL_PATH__"
set "__API_KEY_VAR__=__TOKEN__"
"__ORIGINAL__" %*
`;

const codes = new Set(['ready', 'gateway_unavailable', 'configuration_invalid', 'commands_registered', 'setup_failed',
  'interaction_failed', 'role_api_unavailable', 'role_api_recovered', 'nickname_api_unavailable', 'nickname_api_recovered', 'nickname_retry', 'nickname_configuration_error', 'nickname_configuration_recovered', 'role_retry', 'role_configuration_error', 'role_configuration_recovered', 'stopping', 'fatal_error']);
export function safeLog(code, writer = console.log) {
  writer(JSON.stringify({ event: codes.has(code) ? code : 'fatal_error', at: new Date().toISOString() }));
}

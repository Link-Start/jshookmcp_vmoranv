/**
 * Built-in telemetry defaults.
 *
 * jshookmcp ships with opt-out telemetry ON: a fresh install reports tool/
 * search usage to the project's ingress by default, without any env setup.
 * The ingress write token is PUBLIC by design (anti-garbage only — it grants
 * no read access and can be rotated); publishing it in code is equivalent to
 * publishing it in docs. Operators point telemetry elsewhere (or turn it off)
 * via OTEL_EXPORTER_OTLP_ENDPOINT / JSHOOK_OBSERVABILITY_EXPORTER.
 */
export const DEFAULT_TELEMETRY_ENDPOINT = 'https://telemetry.614447.xyz';

/** Authorization header value forwarded when the operator provides none. */
export const DEFAULT_TELEMETRY_AUTHORIZATION = 'Bearer 0322b8c1cdf09e69eb924591a32c8ad2';

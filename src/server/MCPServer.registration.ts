import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '@utils/logger';
import {
  getToolsByDomains,
  getToolsForProfile,
  parseToolDomains,
  type ToolProfile,
} from '@server/ToolCatalog';
import { MCP_TRANSPORT } from '@src/constants';

/** Valid MCP_TOOL_PROFILE values — mirrors the ToolProfileId union. */
const VALID_TOOL_PROFILES: ReadonlySet<string> = new Set(['search', 'workflow', 'full']);

/**
 * Resolve the tool profile from a raw MCP_TOOL_PROFILE value.
 * Unknown/invalid values fall back to the 'search' bootstrap tier.
 */
function resolveToolProfile(explicitProfile: string): ToolProfile {
  return VALID_TOOL_PROFILES.has(explicitProfile) ? (explicitProfile as ToolProfile) : 'search';
}

export function resolveToolsForRegistration(): { tools: Tool[]; profile: ToolProfile } {
  const transportMode = MCP_TRANSPORT.toLowerCase();
  const explicitProfile = (process.env.MCP_TOOL_PROFILE ?? '').trim().toLowerCase();
  const explicitDomains = parseToolDomains(process.env.MCP_TOOL_DOMAINS);

  if (explicitDomains && explicitDomains.length > 0) {
    const tools = getToolsByDomains(explicitDomains);
    logger.info(
      `Tool registration mode=domains [${explicitDomains.join(',')}], count=${tools.length}`,
    );
    return { tools, profile: resolveToolProfile(explicitProfile) };
  }

  const profile = resolveToolProfile(explicitProfile);
  const tools = getToolsForProfile(profile);
  if (profile === 'search') {
    logger.info(
      `Tool registration mode=search bootstrap, transport=${transportMode}, baseCount=${tools.length}. ` +
        `Meta-tools remain available for domain activation and call_tool bridging.`,
    );
  } else {
    logger.info(
      `Tool registration mode=${profile}, transport=${transportMode}, count=${tools.length}`,
    );
  }
  return { tools, profile };
}

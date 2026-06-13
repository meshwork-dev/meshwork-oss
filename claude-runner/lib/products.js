// products.js — multi-product registry: product.json loading, plugin dir resolution, agent skills
// Extracted from runner.js.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { RUNNER_ROOT, config } = require("./config");
const { worktrees } = require("./state");
const { nowIso } = require("./util");


// ─── Product Registry ────────────────────────────────────────────────────────

const productsDir = path.join(RUNNER_ROOT, "..", "products");
const products = new Map();

function loadProducts() {
  if (!fs.existsSync(productsDir)) return;
  for (const dir of fs.readdirSync(productsDir)) {
    const configPath = path.join(productsDir, dir, "product.json");
    if (fs.existsSync(configPath)) {
      try {
        const product = JSON.parse(fs.readFileSync(configPath, "utf8"));
        products.set(dir, product);
        console.log(`Loaded product: ${dir}${product.pluginDir ? ` (plugin: ${product.pluginDir})` : ''}`);
      } catch (e) {
        console.error(`Failed to load product ${dir}: ${e.message}`);
      }
    }
  }
}
loadProducts();

/**
 * Find a product by ID, Jira project key, or name (case-insensitive).
 * Checks: exact id match → jira.projectKey → case-insensitive id → case-insensitive name.
 * Returns the matching product object, or null if none matches.
 */
function findProduct(query) {
  if (!query) return null;
  // Exact id match
  if (products.has(query)) return products.get(query);
  const q = query.toLowerCase();
  for (const [, product] of products) {
    // Jira project key match (e.g. "EOS", "CER", "WMS")
    if (product.jira?.projectKey && product.jira.projectKey.toLowerCase() === q) return product;
  }
  for (const [id, product] of products) {
    // Case-insensitive id or name match
    if (id.toLowerCase() === q) return product;
    if (product.name && product.name.toLowerCase() === q) return product;
  }
  return null;
}

/**
 * Resolve a product config from a working directory path.
 * Returns the matching product object, or null if none matches.
 */
function resolveProduct(workingDir) {
  if (!workingDir) return null;
  const resolved = path.resolve(workingDir);
  const mappings = config.pathMappings || {};
  for (const [, product] of products) {
    if (!product.workingDir) continue;
    const productDir = path.resolve(product.workingDir);
    // Direct match (host path)
    if (productDir === resolved) return product;
    // Mapped match (container path via pathMappings)
    const mappedDir = mappings[product.workingDir];
    if (mappedDir && path.resolve(mappedDir) === resolved) return product;
  }

  // Worktree fallback: if workingDir is a worktree path, look up the worktree record
  // and match via its baseRepo (the original product workingDir).
  for (const [, wt] of worktrees) {
    if (wt.path && path.resolve(wt.path) === resolved && wt.baseRepo) {
      const baseResolved = path.resolve(wt.baseRepo);
      for (const [, product] of products) {
        if (!product.workingDir) continue;
        if (path.resolve(product.workingDir) === baseResolved) return product;
        const mappedDir = mappings[product.workingDir];
        if (mappedDir && path.resolve(mappedDir) === baseResolved) return product;
      }
    }
  }

  return null;
}

/**
 * Resolve a product config from a Telegram chat ID.
 * Returns the matching product object, or null if none matches.
 */
function resolveProductFromTelegramChat(chatId) {
  if (!chatId) return null;
  const normalised = String(chatId);
  for (const [, product] of products) {
    if (product.telegram?.chatId && String(product.telegram.chatId) === normalised) return product;
  }
  return null;
}

/**
 * Resolve Jira project key for a meeting or job context.
 * Uses product config, falls back to global config.
 */
function resolveJiraProject(productIdOrWorkingDir) {
  let product = null;
  if (productIdOrWorkingDir) {
    product = products.get(productIdOrWorkingDir) || resolveProduct(productIdOrWorkingDir);
  }
  return product?.jira?.projectKey || config.meetings?.jiraProject || "PROJ";
}

/**
 * Resolve Confluence space for a meeting or job context.
 * Uses product config, falls back to global config.
 */
function resolveConfluenceSpace(productIdOrWorkingDir) {
  let product = null;
  if (productIdOrWorkingDir) {
    product = products.get(productIdOrWorkingDir) || resolveProduct(productIdOrWorkingDir);
  }
  return product?.confluence?.space || config.meetings?.confluenceSpace || "CE";
}

/**
 * Resolve the shared skills directory (platform-level, product-agnostic).
 */
function resolveSharedSkillsDir() {
  const rel = config.sharedSkillsDir || 'shared-skills';
  const dir = path.isAbsolute(rel) ? rel : path.resolve(RUNNER_ROOT, '..', rel);
  return fs.existsSync(dir) ? dir : null;
}

/**
 * Resolve the product-specific plugin directory.
 * Falls back to the default meshwork-plugin if no product-specific pluginDir is set.
 */
function resolvePluginDir(product) {
  if (product?.pluginDir) {
    return path.resolve(RUNNER_ROOT, '..', product.pluginDir);
  }
  return config.pluginDir || path.resolve(RUNNER_ROOT, '..', 'meshwork-plugin');
}

/**
 * Resolve all plugin directories for a product: shared-skills first, then product-specific.
 * Shared skills provide generic frameworks; product plugins provide domain context.
 * Claude CLI merges skills from all --plugin-dir paths (repeatable flag).
 */
function resolvePluginDirs(product) {
  const dirs = [];
  const shared = resolveSharedSkillsDir();
  if (shared) dirs.push(shared);
  dirs.push(resolvePluginDir(product));
  return dirs;
}

/**
 * Apply plugin directories to a CLI args array.
 * Removes any existing --plugin-dir entries and appends all resolved dirs.
 */
function applyProductPluginDir(args, product) {
  // Remove all existing --plugin-dir pairs
  let idx;
  while ((idx = args.indexOf('--plugin-dir')) >= 0) {
    args.splice(idx, idx + 1 < args.length ? 2 : 1);
  }
  // Append shared + product plugin dirs
  for (const dir of resolvePluginDirs(product)) {
    args.push('--plugin-dir', dir);
  }
  return args;
}

/**
 * Parse agent markdown frontmatter for skill/context declarations.
 * Skills field declares which skill directories the agent needs loaded.
 * Context field declares which context files to include (e.g., company-brief).
 * Returns { skills: string[], context: string[] } or null if no declarations found.
 */
function parseAgentSkills(agentFilePath) {
  try {
    const content = fs.readFileSync(agentFilePath, 'utf8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;

    const fm = fmMatch[1];
    const result = { skills: [], context: [] };

    for (const key of ['skills', 'context']) {
      const block = fm.match(new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s+.+\\n?)*)`, 'm'));
      if (block) {
        for (const m of block[1].matchAll(/^\s+-\s+(.+)$/gm)) {
          result[key].push(m[1].trim());
        }
      }
    }

    return (result.skills.length || result.context.length) ? result : null;
  } catch {
    return null;
  }
}

/**
 * Resolve all skills needed for an agent, including team member skills.
 * For team leads, merges skill declarations from all teammate agent files.
 */
function resolveAgentSkills(agentName, product) {
  const pluginDir = resolvePluginDir(product);
  const agentFile = path.join(pluginDir, 'agents', `${agentName}.md`);

  const parsed = parseAgentSkills(agentFile);
  if (!parsed) return null;

  const allSkills = new Set(parsed.skills);
  const allContext = new Set(parsed.context);

  // If this is a team lead, also include teammate skills
  const teamConfig = config.teams?.teamLeads?.[agentName];
  if (teamConfig?.teammates?.length) {
    for (const teammate of teamConfig.teammates) {
      const teammateFile = path.join(pluginDir, 'agents', `${teammate}.md`);
      const teammateParsed = parseAgentSkills(teammateFile);
      if (teammateParsed) {
        teammateParsed.skills.forEach(s => allSkills.add(s));
        teammateParsed.context.forEach(c => allContext.add(c));
      }
    }
  }

  return { skills: [...allSkills], context: [...allContext] };
}

/**
 * Count total available skill directories across product + shared.
 */
function countSkillDirs(pluginDir, sharedDir) {
  let count = 0;
  try {
    count += fs.readdirSync(path.join(pluginDir, 'skills')).filter(
      f => fs.statSync(path.join(pluginDir, 'skills', f)).isDirectory()
    ).length;
  } catch {}
  try {
    if (sharedDir) {
      count += fs.readdirSync(path.join(sharedDir, 'skills')).filter(
        f => fs.statSync(path.join(sharedDir, 'skills', f)).isDirectory()
      ).length;
    }
  } catch {}
  return count;
}

/**
 * Build an optimized plugin directory containing only the skills an agent needs.
 * Creates a temp directory with symlinks to required skills from shared-skills
 * and product-plugin, plus essential config files (agents, commands, hooks, .mcp.json).
 * Returns the temp directory path, or null to fall back to full plugin dirs.
 */
function buildOptimizedPluginDir(agentName, product, jobId, provider) {
  if (!agentName || !product) return null;
  const isLocal = provider === 'local';

  const resolved = resolveAgentSkills(agentName, product);
  if (!resolved) return null;

  const pluginDir = resolvePluginDir(product);
  const sharedDir = resolveSharedSkillsDir();
  try {
    const tmpBase = path.join(os.tmpdir(), `meshwork-ctx-${jobId}`);
    const tmpSkills = path.join(tmpBase, 'skills');
    // Clean leftover dir from previous attempt — retries reuse jobId, so existing
    // symlinks would cause EEXIST on subsequent symlinkSync calls.
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.mkdirSync(tmpSkills, { recursive: true });

    // Symlink full agents directory (all agent defs available for team spawning)
    const agentsDir = path.join(pluginDir, 'agents');
    if (fs.existsSync(agentsDir)) {
      fs.symlinkSync(agentsDir, path.join(tmpBase, 'agents'));
    }

    // Symlink only declared skills — product plugin first, then shared
    let skillsResolved = 0;
    for (const skillName of resolved.skills) {
      const productSkill = path.join(pluginDir, 'skills', skillName);
      const sharedSkill = sharedDir ? path.join(sharedDir, 'skills', skillName) : null;
      const source = fs.existsSync(productSkill) ? productSkill :
                     (sharedSkill && fs.existsSync(sharedSkill)) ? sharedSkill : null;
      if (source) {
        fs.symlinkSync(source, path.join(tmpSkills, skillName));
        skillsResolved++;
      }
    }

    // Symlink context files
    for (const ctxName of resolved.context) {
      if (ctxName === 'company-brief') {
        const briefPath = path.join(pluginDir, 'company-brief.md');
        if (fs.existsSync(briefPath)) {
          fs.symlinkSync(briefPath, path.join(tmpBase, 'company-brief.md'));
        }
      }
    }

    // LOCAL MODELS: skip commands, hooks, and MCP config (saves ~15-20K tokens from tool defs)
    // CLAUDE: include everything for full capability
    if (!isLocal) {
      for (const item of ['commands', 'hooks', '.mcp.json']) {
        const src = path.join(pluginDir, item);
        if (fs.existsSync(src)) {
          fs.symlinkSync(src, path.join(tmpBase, item));
        }
      }
    }

    const totalAvailable = countSkillDirs(pluginDir, sharedDir);
    console.log(`[${nowIso()}] Context optimization: ${agentName} gets ${skillsResolved}/${totalAvailable} skills (declared: ${resolved.skills.length})${isLocal ? ' [LOCAL: single-agent, no MCP]' : ''}`);

    return tmpBase;
  } catch (err) {
    console.error(`[${nowIso()}] Failed to build optimized plugin dir: ${err.message}`);
    return null;
  }
}

/**
 * Build a filtered MCP config file for an agent and return its path.
 * Merges product .mcp.json + shared-skills .mcp.json + working-dir .mcp.json,
 * then keeps only servers in config.agentMcps[agent] (plus any with alwaysLoad: true).
 * Used with --mcp-config + --strict-mcp-config to suppress fan-out of unused MCPs.
 * Returns the file path, or null if no allowlist is configured for the agent.
 */
function buildFilteredMcpConfig(agentName, product, jobId, workingDir, optimizedDir) {
  if (!agentName || !product) return null;
  const baseAllow = config.agentMcps?.[agentName];
  if (!Array.isArray(baseAllow)) return null; // No allowlist → fall back to default behaviour

  // Team leads (e.g. engineer-planner) spawn teammates in-process — union their allowlists
  // so the lead's subprocess has every MCP its teammates may need.
  const allowlistSet = new Set(baseAllow);
  const teamConfig = config.teams?.teamLeads?.[agentName];
  if (teamConfig?.teammates?.length) {
    for (const teammate of teamConfig.teammates) {
      const tAllow = config.agentMcps?.[teammate];
      if (Array.isArray(tAllow)) tAllow.forEach(s => allowlistSet.add(s));
    }
  }
  const allowlist = [...allowlistSet];

  const merged = { mcpServers: {} };
  const sources = [];
  const sharedDir = resolveSharedSkillsDir();
  if (sharedDir) sources.push(path.join(sharedDir, '.mcp.json'));
  sources.push(path.join(resolvePluginDir(product), '.mcp.json'));
  if (workingDir) sources.push(path.join(workingDir, '.mcp.json'));

  for (const src of sources) {
    try {
      if (!fs.existsSync(src)) continue;
      const data = JSON.parse(fs.readFileSync(src, 'utf8'));
      if (data.mcpServers) {
        Object.assign(merged.mcpServers, data.mcpServers);
      }
    } catch (err) {
      console.error(`[${nowIso()}] Failed to read ${src}: ${err.message}`);
    }
  }

  const allow = new Set(allowlist);
  const filtered = { mcpServers: {} };
  let kept = 0, alwaysLoadKept = 0, dropped = 0;
  for (const [name, def] of Object.entries(merged.mcpServers)) {
    if (allow.has(name)) {
      filtered.mcpServers[name] = def;
      kept++;
    } else if (def && def.alwaysLoad === true) {
      filtered.mcpServers[name] = def;
      alwaysLoadKept++;
    } else {
      dropped++;
    }
  }

  // Only write into optimizedDir so cleanupOptimizedPluginDir removes it; otherwise we'd leak.
  if (!optimizedDir) return null;

  try {
    const outPath = path.join(optimizedDir, `mcp-${jobId}.json`);
    fs.writeFileSync(outPath, JSON.stringify(filtered, null, 2));
    console.log(`[${nowIso()}] MCP filter: ${agentName} → kept ${kept} (+${alwaysLoadKept} alwaysLoad), dropped ${dropped} → ${outPath}`);
    return outPath;
  } catch (err) {
    console.error(`[${nowIso()}] Failed to write filtered MCP config: ${err.message}`);
    return null;
  }
}

/**
 * Clean up temporary optimized plugin directory after job completion.
 */
function cleanupOptimizedPluginDir(job) {
  if (job._tmpPluginDir) {
    try {
      fs.rmSync(job._tmpPluginDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`[${nowIso()}] Failed to cleanup tmp plugin dir: ${err.message}`);
    }
    delete job._tmpPluginDir;
  }
}

/**
 * Build file-routing rules that tell agents where plugin vs project files belong.
 * Prevents agents from creating plugin directories (agents/, skills/, commands/)
 * inside the product working directory instead of the platform plugin directory.
 */
function buildFileRoutingRules(product) {
  if (!product) return null;
  const pluginDir = resolvePluginDir(product);
  const lines = [
    "<file-routing-rules>",
    "CRITICAL — File Location Rules:",
    `Your working directory is for APPLICATION CODE only (source, tests, docs, configs).`,
    `Plugin files (agent definitions, skills, commands, hooks) belong in the PLATFORM plugin directory:`,
    `  Plugin directory: ${pluginDir}`,
    `  - Agent definitions → ${pluginDir}/agents/`,
    `  - Skills → ${pluginDir}/skills/`,
    `  - Commands → ${pluginDir}/commands/`,
    `  - Hooks → ${pluginDir}/hooks/`,
    "",
    "DO NOT create agent/, skill/, command/, or hook/ directories inside the working directory.",
    "If a task requires creating or modifying plugin files, write them to the plugin directory above.",
    "If a task requires creating or modifying application code, write it to the working directory.",
    "</file-routing-rules>",
  ];
  return lines.join("\n");
}

/**
 * Get the product ID for a job (used for per-product concurrency).
 * Falls back to "_default" for jobs without a resolvable product.
 */
function getProductIdForJob(job) {
  if (job._productId) return job._productId;
  const product = resolveProduct(job.workingDir);
  return product?.id || "_default";
}

function resolveProductWorkingDir(product) {
  const mappings = config.pathMappings || {};
  const hostDir = product.workingDir;
  if (!hostDir) return null;
  // If a mapping exists (host → container), use the container path
  if (mappings[hostDir]) return mappings[hostDir];
  return hostDir;
}

/**
 * Find which product owns a given Jira issue key (by project key prefix).
 */
function resolveProductForIssueKey(issueKey) {
  if (!issueKey) return null;
  const projectKey = String(issueKey).split("-")[0]?.toUpperCase();
  if (!projectKey) return null;
  for (const [productId, product] of products) {
    if ((product.jira?.projectKey || "").toUpperCase() === projectKey) {
      return { productId, product };
    }
  }
  return null;
}

module.exports = {
  productsDir,
  products,
  loadProducts,
  findProduct,
  resolveProduct,
  resolveProductFromTelegramChat,
  resolveJiraProject,
  resolveConfluenceSpace,
  resolveSharedSkillsDir,
  resolvePluginDir,
  resolvePluginDirs,
  applyProductPluginDir,
  parseAgentSkills,
  resolveAgentSkills,
  countSkillDirs,
  buildOptimizedPluginDir,
  buildFilteredMcpConfig,
  cleanupOptimizedPluginDir,
  buildFileRoutingRules,
  getProductIdForJob,
  resolveProductWorkingDir,
  resolveProductForIssueKey,
};

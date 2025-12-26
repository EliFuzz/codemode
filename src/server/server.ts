import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server, Servers } from 'src/server/client';

export interface ServerTool {
  name: string;
  description?: string;
  inputSchema: any;
}

interface ServerConfig {
  tools: Record<string, any>;
  interfaces: string;
  serverTools: Record<string, ServerTool>;
}

let server: McpServer | null = null;
let serverConfig: ServerConfig = { tools: {}, interfaces: '', serverTools: {} };
let toolRegistry: Array<{ serverName: string; cfg: Server; tool: ServerTool }> =
  [];

export const getServerConfig = () => serverConfig;
export const getServer = () => server!;
export const getToolRegistry = () => toolRegistry;

export const init = async () => {
  const servers = JSON.parse(
    (await readFile(process.env.CODEMODE_SERVERS || '', 'utf8')) || '{}'
  );
  await getAllServerTools(servers);
  server = new McpServer({ name: 'codemode', version: '1.0.0' });
  await registerTools();
  await server.connect(new StdioServerTransport());
};

const registerTools = async (): Promise<void> => {
  try {
    const toolsDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../tools'
    );
    const toolFiles = (await readdir(toolsDir)).filter(
      (file: string) => file.endsWith('.js') || file.endsWith('.ts')
    );
    for (const file of toolFiles) {
      await import(path.join(toolsDir, file));
    }
  } catch (error) {
    console.error('Error registering tools:', error);
    throw error;
  }
};

export const executeTool = async (
  serverName: string,
  toolName: string,
  args: Record<string, any>
) => {
  const entry = toolRegistry.find(
    (e) => e.serverName === serverName && e.tool.name === toolName
  );
  if (!entry) throw new Error(`Tool ${serverName}.${toolName} not found`);
  const result = await getClient(entry.cfg, serverName, async (client) =>
    client.callTool({ name: toolName, arguments: args }, CallToolResultSchema)
  );
  return result.structuredContent || result.content;
};

const getAllServerTools = async (input: Servers) => {
  const rawTools: Record<string, (args: any) => Promise<any>> = {};
  const toolList: ServerTool[] = [];

  await Promise.all(
    Object.entries(input.servers).map(async ([serverName, cfg]) => {
      try {
        const serverTools = await getClient(
          cfg,
          serverName,
          async (client) =>
            (
              await client.request(
                { method: 'tools/list' },
                ListToolsResultSchema
              )
            ).tools
        );
        const filteredTools = cfg.codemode?.allow
          ? serverTools.filter((t) => cfg.codemode?.allow?.includes(t.name))
          : serverTools.filter((t) => !cfg.codemode?.deny?.includes(t.name));

        filteredTools.forEach((tool) => {
          const fullName = `${serverName}.${tool.name}`;
          const parts = fullName.split('.');
          const callableName =
            parts.length > 1
              ? `${sanitize(parts[0])}.${parts.slice(1).map(sanitize).join('_')}`
              : sanitize(fullName);
          serverConfig.serverTools[callableName] = {
            ...tool,
            name: callableName,
          };
          rawTools[fullName] = (args: any) =>
            executeTool(serverName, tool.name, args);
          toolList.push({
            name: fullName,
            description: tool.description,
            inputSchema: tool.inputSchema,
          });
          toolRegistry.push({
            serverName: serverName,
            cfg,
            tool: {
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            },
          });
        });
      } catch (e) {
        console.warn(
          `Failed to connect to ${serverName}:`,
          e instanceof Error ? e.message : String(e)
        );
      }
    })
  );

  serverConfig.tools = prepareTools(rawTools);
  serverConfig.interfaces = generateInterfaces(toolList);
};

const expandEnv = (s: string) =>
  s.replaceAll(/\$\{([^}]+)\}/g, (_, v) => process.env[v] || _);
const expand = (c: Server): Server => ({
  ...c,
  ...(c.headers && {
    headers: Object.fromEntries(
      Object.entries(c.headers).map(([k, v]) => [k, expandEnv(v)])
    ),
  }),
  ...(c.env && {
    env: Object.fromEntries(
      Object.entries(c.env).map(([k, v]) => [k, expandEnv(v)])
    ),
  }),
});

const getClient = async <T>(
  cfg: Server,
  name: string,
  cb: (client: Client) => Promise<T>
) => {
  const { url, headers, env, command, args } = expand(cfg);
  const transport = url
    ? new StreamableHTTPClientTransport(new URL(url), {
        requestInit: headers ? { headers } : undefined,
      })
    : new StdioClientTransport({
        command: command!,
        args: args || [],
        env: { ...env, NODE_NO_WARNINGS: '1' },
      });

  const client = new Client({ name, version: '1.0.0' });
  try {
    await client.connect(transport);
    return await cb(client);
  } finally {
    await client.close();
  }
};

const sanitize = (name: string) =>
  name.replaceAll(/\W/g, '_').replace(/^\d/, '_$&');

const prepareTools = (tools: Record<string, (args: any) => Promise<any>>) => {
  const out: Record<string, any> = {};
  for (const [name, fn] of Object.entries(tools)) {
    const parts = name.split('.');
    if (parts.length > 1) {
      const ns = sanitize(parts[0]);
      const tool = parts.slice(1).map(sanitize).join('_');
      out[ns] = out[ns] || {};
      out[ns][tool] = fn;
    } else {
      out[sanitize(name)] = fn;
    }
  }
  return out;
};

const generateInterfaces = (tools: ServerTool[]): string =>
  tools.map(generateInterface).join('\n');

const generateInterface = (tool: ServerTool): string => {
  const parts = tool.name.split('.');

  return parts.length > 1
    ? `namespace ${sanitize(parts[0])} { /* ${tool.description} */ function ${parts.slice(1).map(sanitize).join('_')}(args: ${toType(tool.inputSchema)}): Promise<any>; }`
    : `/* ${tool.description} */ function ${sanitize(tool.name)}(args: ${toType(tool.inputSchema)}): Promise<any>;`;
};

const toType = (s: any, d = 0): string => {
  if (!s) return 'any';
  if (s.enum)
    return s.enum
      .map((v: any) => (typeof v === 'string' ? `"${v}"` : v))
      .join(' | ');
  if (s.type === 'array')
    return s.items ? `(${toType(s.items, d + 1)})[]` : 'any[]';
  if (s.type === 'object') {
    if (!s.properties || d > 2) return '{ [key: string]: any }';
    return `{ ${Object.entries(s.properties)
      .map(
        ([k, v]: [string, any]) =>
          `${k}${s.required?.includes(k) ? '' : '?'}: ${toType(v, d + 1)}`
      )
      .join('; ')} }`;
  }
  return (
    {
      string: 'string',
      number: 'number',
      integer: 'number',
      boolean: 'boolean',
      null: 'null',
    }[s.type as string] || 'any'
  );
};

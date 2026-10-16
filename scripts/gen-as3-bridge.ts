import fs from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = join(SCRIPT_DIR, "..");

const BRIDGE_TS_RETURN_TYPE_METADATA = "BridgeTsReturnType";
const BRIDGE_TS_PARAM_TYPE_METADATA = "BridgeTsParamType";
const BRIDGE_TS_TYPES_ALIAS = "FlashTypes";
const BRIDGE_TS_TYPES_MODULE = "./Types";

type Metadata = {
  name: string;
  arg: string | null;
  line: number;
};

type BridgeParameter = {
  name: string;
  type: string;
  tsType: string | null;
  optional: boolean;
  rest: boolean;
};

type ParsedMethod = {
  className: string;
  classNamespace: string | null;
  packageName: string;
  classFqn: string; // class fully qualified name (package + class)
  name: string;
  parameters: BridgeParameter[];
  returnType: string;
  isStatic: boolean;
  metadata: Metadata[];
  line: number;
  filePath: string;
};

type ParsedFile = {
  filePath: string;
  packageName: string;
  className: string | null;
  classNamespace: string | null;
  methods: ParsedMethod[];
};

type BridgeExportEntry = {
  externalName: string;
  className: string;
  classFqn: string;
  methodName: string;
  parameters: BridgeParameter[];
  returnType: string;
  tsReturnType: string | null;
  filePath: string;
  line: number;
};

type BridgeEventEntry = {
  eventName: string;
  className: string;
  classFqn: string;
  methodName: string;
  parameters: BridgeParameter[];
  returnType: string;
  tsReturnType: string | null;
  filePath: string;
  line: number;
};

type BridgeModel = {
  exports: BridgeExportEntry[];
  events: BridgeEventEntry[];
};

type GenerateOptions = {
  repoRoot?: string;
  check?: boolean;
};

type GenerateResult = {
  model: BridgeModel;
  as3Registry: string;
  swfDts: string;
  as3OutputPath: string;
  swfDtsOutputPath: string;
};

function isMetadataLine(line: string): Metadata | null {
  const match = line.trim().match(/^\[(\w+)(?:\("([^"]*)"\))?\]$/);
  if (!match) {
    return null;
  }

  const name = match[1];
  if (!name) {
    return null;
  }

  return {
    name,
    arg: match[2] ?? null,
    line: 0,
  };
}

function findMetadata(metadata: Metadata[], name: string): Metadata | null {
  return metadata.find((entry) => entry.name === name) ?? null;
}

function removeBlockComments(value: string): string {
  return value.replace(/\/\*[\s\S]*?\*\//g, "");
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quote) {
      current += char;
      if (char === quote && text[i - 1] !== "\\") {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === "(") {
      depthParen += 1;
      current += char;
      continue;
    }

    if (char === ")") {
      depthParen -= 1;
      current += char;
      continue;
    }

    if (char === "{") {
      depthBrace += 1;
      current += char;
      continue;
    }

    if (char === "}") {
      depthBrace -= 1;
      current += char;
      continue;
    }

    if (char === "[") {
      depthBracket += 1;
      current += char;
      continue;
    }

    if (char === "]") {
      depthBracket -= 1;
      current += char;
      continue;
    }

    if (
      char === separator &&
      depthParen === 0 &&
      depthBrace === 0 &&
      depthBracket === 0
    ) {
      parts.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim().length > 0) {
    parts.push(current.trim());
  }

  return parts;
}

export function parseParameterList(rawParams: string): BridgeParameter[] {
  const cleanedParams = removeBlockComments(rawParams).trim();
  if (!cleanedParams) {
    return [];
  }

  const chunks = splitTopLevel(cleanedParams, ",");

  return chunks
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      if (chunk.startsWith("...")) {
        const restName = chunk.slice(3).trim();
        return {
          name: restName,
          type: "*",
          tsType: null,
          optional: false,
          rest: true,
        } satisfies BridgeParameter;
      }

      const match = chunk.match(
        /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([^=]+?))?\s*(?:=\s*(.+))?$/,
      );

      if (!match) {
        throw new Error(`Unable to parse parameter declaration: "${chunk}"`);
      }

      const [, name, type, defaultValue] = match;
      if (!name) {
        throw new Error(`Unable to parse parameter declaration: "${chunk}"`);
      }

      return {
        name,
        type: (type ?? "*").trim(),
        tsType: null,
        optional: defaultValue != null,
        rest: false,
      } satisfies BridgeParameter;
    });
}

export function mapAs3Type(type: string): string {
  const normalized = type.trim();

  switch (normalized) {
    case "void":
      return "void";
    case "String":
      return "string";
    case "Boolean":
      return "boolean";
    case "int":
    case "uint":
    case "Number":
      return "number";
    case "Array":
      return "unknown[]";
    case "Object":
      return "Record<string, unknown>";
    case "Function":
      return "(...args: unknown[]) => unknown";
    case "*":
      return "unknown";
    default:
      return "unknown";
  }
}

function resolveTsReturnType(method: ParsedMethod): string | null {
  const metadata = findMetadata(method.metadata, BRIDGE_TS_RETURN_TYPE_METADATA);
  if (!metadata) {
    return null;
  }

  const value = metadata.arg?.trim();
  if (!value) {
    throw new Error(
      `${BRIDGE_TS_RETURN_TYPE_METADATA} metadata requires a non-empty value in ${relative(DEFAULT_REPO_ROOT, method.filePath)}:${metadata.line}`,
    );
  }

  if (value.includes("import(")) {
    throw new Error(
      `${BRIDGE_TS_RETURN_TYPE_METADATA} in ${relative(DEFAULT_REPO_ROOT, method.filePath)}:${metadata.line} should not use import() expressions. Use ${BRIDGE_TS_TYPES_ALIAS}.TypeName (for example: ${BRIDGE_TS_TYPES_ALIAS}.TargetInfo | null).`,
    );
  }

  return value;
}

function validateTsTypeMetadataValue(
  metadataName: string,
  value: string | null | undefined,
  filePath: string,
  line: number,
): string {
  const type = value?.trim();
  if (!type) {
    throw new Error(
      `${metadataName} metadata requires a non-empty value in ${relative(DEFAULT_REPO_ROOT, filePath)}:${line}`,
    );
  }

  if (type.includes("import(")) {
    throw new Error(
      `${metadataName} in ${relative(DEFAULT_REPO_ROOT, filePath)}:${line} should not use import() expressions. Use ${BRIDGE_TS_TYPES_ALIAS}.TypeName (for example: ${BRIDGE_TS_TYPES_ALIAS}.TargetInfo | null).`,
    );
  }

  return type;
}

function resolveTsParameterTypes(method: ParsedMethod): Map<string, string> {
  const overrides = new Map<string, string>();

  for (const metadata of method.metadata) {
    if (metadata.name !== BRIDGE_TS_PARAM_TYPE_METADATA) {
      continue;
    }

    const value = validateTsTypeMetadataValue(
      BRIDGE_TS_PARAM_TYPE_METADATA,
      metadata.arg,
      method.filePath,
      metadata.line,
    );
    const separatorIndex = value.indexOf(":");
    if (separatorIndex <= 0) {
      throw new Error(
        `${BRIDGE_TS_PARAM_TYPE_METADATA} metadata must use "parameterName: Type" in ${relative(DEFAULT_REPO_ROOT, method.filePath)}:${metadata.line}`,
      );
    }

    const parameterName = value.slice(0, separatorIndex).trim();
    const tsType = value.slice(separatorIndex + 1).trim();
    if (!parameterName || !tsType) {
      throw new Error(
        `${BRIDGE_TS_PARAM_TYPE_METADATA} metadata must use "parameterName: Type" in ${relative(DEFAULT_REPO_ROOT, method.filePath)}:${metadata.line}`,
      );
    }

    if (!method.parameters.some((parameter) => parameter.name === parameterName)) {
      throw new Error(
        `${BRIDGE_TS_PARAM_TYPE_METADATA} references unknown parameter "${parameterName}" in ${relative(DEFAULT_REPO_ROOT, method.filePath)}:${metadata.line}`,
      );
    }

    if (overrides.has(parameterName)) {
      throw new Error(
        `Duplicate ${BRIDGE_TS_PARAM_TYPE_METADATA} metadata for parameter "${parameterName}" in ${relative(DEFAULT_REPO_ROOT, method.filePath)}:${metadata.line}`,
      );
    }

    overrides.set(parameterName, tsType);
  }

  return overrides;
}

function applyTsParameterTypes(method: ParsedMethod): BridgeParameter[] {
  const overrides = resolveTsParameterTypes(method);
  if (overrides.size === 0) {
    return method.parameters;
  }

  return method.parameters.map((parameter) => ({
    ...parameter,
    tsType: overrides.get(parameter.name) ?? parameter.tsType,
  }));
}

function formatFunctionParameter(parameter: BridgeParameter): string {
  if (parameter.rest) {
    const baseType = parameter.tsType ?? mapAs3Type(parameter.type);
    const restType = baseType.endsWith("[]") ? baseType : `${baseType}[]`;
    return `...${parameter.name}: ${restType}`;
  }

  const suffix = parameter.optional ? "?" : "";
  return `${parameter.name}${suffix}: ${parameter.tsType ?? mapAs3Type(parameter.type)}`;
}

function formatFunctionParameters(parameters: BridgeParameter[]): string {
  return parameters.map(formatFunctionParameter).join(", ");
}

function formatFunctionSignature(
  parameters: BridgeParameter[],
  returnType: string,
): string {
  return `(${formatFunctionParameters(parameters)}) => ${returnType}`;
}

function formatFunctionProperty(
  name: string,
  parameters: BridgeParameter[],
  returnType: string,
  indent: string,
  optional = false,
  quoteName = true,
): string[] {
  const canUseIdentifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
  const renderedName = quoteName || !canUseIdentifier ? JSON.stringify(name) : name;
  const propertyName = `${renderedName}${optional ? "?" : ""}`;
  const singleLine = `${indent}${propertyName}: ${formatFunctionSignature(parameters, returnType)};`;
  if (singleLine.length <= 80 || parameters.length === 0) {
    return [singleLine];
  }

  const parameterIndent = `${indent}  `;
  return [
    `${indent}${propertyName}: (`,
    ...parameters.map(
      (parameter) => `${parameterIndent}${formatFunctionParameter(parameter)},`,
    ),
    `${indent}) => ${returnType};`,
  ];
}

function resolveRenderedReturnType(
  as3ReturnType: string,
  tsReturnType: string | null,
): string {
  if (tsReturnType !== null) {
    return tsReturnType;
  }

  if (as3ReturnType.trim() === "Object") {
    return "Record<string, unknown> | null";
  }

  return mapAs3Type(as3ReturnType);
}

function shouldImportFlashTypes(model: BridgeModel): boolean {
  const usesAlias = (tsReturnType: string | null) =>
    tsReturnType?.includes(`${BRIDGE_TS_TYPES_ALIAS}.`) ?? false;
  const parameterUsesAlias = (parameters: BridgeParameter[]) =>
    parameters.some((parameter) => usesAlias(parameter.tsType));

  return (
    model.exports.some((entry) => usesAlias(entry.tsReturnType)) ||
    model.exports.some((entry) => parameterUsesAlias(entry.parameters)) ||
    model.events.some((entry) => usesAlias(entry.tsReturnType)) ||
    model.events.some((entry) => parameterUsesAlias(entry.parameters))
  );
}

function parseAs3File(filePath: string, source: string): ParsedFile {
  const packageMatch = source.match(/package\s+([A-Za-z0-9_.]+)\s*\{/m);
  const packageName = packageMatch?.[1] ?? "";

  const lines = source.split(/\r?\n/);
  const methods: ParsedMethod[] = [];

  let pendingMetadata: Metadata[] = [];
  let className: string | null = null;
  let classNamespace: string | null = null;

  lines.forEach((line, index) => {
    const metadata = isMetadataLine(line);
    if (metadata) {
      metadata.line = index + 1;
      pendingMetadata.push(metadata);
      return;
    }

    const classMatch = line.match(
      /^\s*public\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/,
    );
    if (classMatch) {
      const matchedClassName = classMatch[1];
      if (!matchedClassName) {
        throw new Error(
          `Unable to parse class declaration in ${relative(DEFAULT_REPO_ROOT, filePath)}:${index + 1}`,
        );
      }

      className = matchedClassName;
      const namespaceMetadata = findMetadata(pendingMetadata, "BridgeNamespace");
      classNamespace = namespaceMetadata?.arg ?? null;
      pendingMetadata = [];
      return;
    }

    const methodMatch = line.match(
      /^\s*public\s+(static\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?::\s*([A-Za-z0-9_*]+))?/,
    );

    if (methodMatch) {
      if (!className) {
        throw new Error(
          `Found method before class declaration in ${relative(DEFAULT_REPO_ROOT, filePath)}:${index + 1}`,
        );
      }

      const methodMetadata = pendingMetadata;
      pendingMetadata = [];

      const methodName = methodMatch[2];
      if (!methodName) {
        throw new Error(
          `Unable to parse method declaration in ${relative(DEFAULT_REPO_ROOT, filePath)}:${index + 1}`,
        );
      }
      const methodParameters = parseParameterList(methodMatch[3] ?? "");
      const returnType = methodMatch[4] ?? "void";

      methods.push({
        className,
        classNamespace,
        packageName,
        classFqn: `${packageName}.${className}`,
        name: methodName,
        parameters: methodParameters,
        returnType,
        isStatic: Boolean(methodMatch[1]),
        metadata: methodMetadata,
        line: index + 1,
        filePath,
      });

      return;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) {
      return;
    }

    pendingMetadata = [];
  });

  return {
    filePath,
    packageName,
    className,
    classNamespace,
    methods,
  };
}

async function collectAs3Files(rootDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".as")) {
        continue;
      }

      if (fullPath.endsWith("generated/BridgeRegistryGenerated.as")) {
        continue;
      }

      files.push(fullPath);
    }
  }

  await walk(rootDir);
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function buildBridgeModel(parsedFiles: ParsedFile[]): BridgeModel {
  const exports: BridgeExportEntry[] = [];
  const events: BridgeEventEntry[] = [];

  for (const parsedFile of parsedFiles) {
    for (const method of parsedFile.methods) {
      const exportMetadata = findMetadata(method.metadata, "BridgeExport");
      const ignoreMetadata = findMetadata(method.metadata, "BridgeIgnore");
      const eventMetadata = findMetadata(method.metadata, "BridgeEvent");

      const tsReturnType = resolveTsReturnType(method);
      const parameters = applyTsParameterTypes(method);

      if (eventMetadata) {
        if (!eventMetadata.arg) {
          throw new Error(
            `BridgeEvent metadata requires a value in ${relative(DEFAULT_REPO_ROOT, method.filePath)}:${method.line}`,
          );
        }

        const eventName = eventMetadata.arg.trim();
        // if (!eventName.includes(".")) {
        //   throw new Error(
        //     `BridgeEvent name must be namespaced in ${relative(DEFAULT_REPO_ROOT, method.filePath)}:${method.line}`,
        //   );
        // }

        events.push({
          eventName,
          className: method.className,
          classFqn: method.classFqn,
          methodName: method.name,
          parameters,
          returnType: method.returnType,
          tsReturnType,
          filePath: method.filePath,
          line: method.line,
        });
      }

      if (!method.isStatic) {
        if (exportMetadata || ignoreMetadata) {
          throw new Error(
            `BridgeExport/BridgeIgnore can only be used on static methods: ${relative(DEFAULT_REPO_ROOT, method.filePath)}:${method.line}`,
          );
        }

        continue;
      }

      if (!method.classNamespace) {
        if (exportMetadata || ignoreMetadata) {
          throw new Error(
            `Class missing BridgeNamespace for exported method in ${relative(DEFAULT_REPO_ROOT, method.filePath)}:${method.line}`,
          );
        }
        continue;
      }

      if (exportMetadata && ignoreMetadata) {
        throw new Error(
          `Method cannot have both BridgeExport and BridgeIgnore: ${relative(DEFAULT_REPO_ROOT, method.filePath)}:${method.line}`,
        );
      }

      if (!exportMetadata && !ignoreMetadata) {
        throw new Error(
          `Missing BridgeExport/BridgeIgnore metadata for static method ${method.name} in ${relative(DEFAULT_REPO_ROOT, method.filePath)}:${method.line}`,
        );
      }

      if (ignoreMetadata) {
        continue;
      }

      const exportedMethodName = exportMetadata?.arg?.trim() || method.name;
      const externalName = `${method.classNamespace}.${exportedMethodName}`;

      exports.push({
        externalName,
        className: method.className,
        classFqn: method.classFqn,
        methodName: method.name,
        parameters,
        returnType: method.returnType,
        tsReturnType,
        filePath: method.filePath,
        line: method.line,
      });
    }
  }

  const exportByName = new Map<string, BridgeExportEntry>();
  for (const entry of exports) {
    const existing = exportByName.get(entry.externalName);
    if (existing) {
      throw new Error(
        [
          `Duplicate bridge export name "${entry.externalName}"`,
          `- ${relative(DEFAULT_REPO_ROOT, existing.filePath)}:${existing.line}`,
          `- ${relative(DEFAULT_REPO_ROOT, entry.filePath)}:${entry.line}`,
        ].join("\n"),
      );
    }
    exportByName.set(entry.externalName, entry);
  }

  const eventByName = new Map<string, BridgeEventEntry>();
  for (const entry of events) {
    const existing = eventByName.get(entry.eventName);
    if (existing) {
      throw new Error(
        [
          `Duplicate bridge event name "${entry.eventName}"`,
          `- ${relative(DEFAULT_REPO_ROOT, existing.filePath)}:${existing.line}`,
          `- ${relative(DEFAULT_REPO_ROOT, entry.filePath)}:${entry.line}`,
        ].join("\n"),
      );
    }
    eventByName.set(entry.eventName, entry);
  }

  exports.sort((a, b) => a.externalName.localeCompare(b.externalName));
  events.sort((a, b) => a.eventName.localeCompare(b.eventName));

  return { exports, events };
}

export function renderAs3Registry(model: BridgeModel): string {
  const importSet = new Set<string>();
  for (const entry of model.exports) {
    importSet.add(entry.classFqn);
  }

  const imports = [...importSet].sort((a, b) => a.localeCompare(b));

  const lines: string[] = [
    "// AUTO-GENERATED FILE. DO NOT EDIT.",
    "package lucent.generated",
    "{",
    "  import lucent.Externalizer;",
  ];

  for (const importLine of imports) {
    lines.push(`  import ${importLine};`);
  }

  lines.push(
    "",
    "  public class BridgeRegistryGenerated",
    "  {",
    "    public static function register(external:Externalizer):void",
    "    {",
  );

  for (const entry of model.exports) {
    lines.push(
      `      external.externalize("${entry.externalName}", ${entry.className}.${entry.methodName});`,
    );
  }

  lines.push("    }", "  }", "}", "");
  return lines.join("\n");
}

export function renderWindowSwfDts(model: BridgeModel): string {
  const lines: string[] = [
    "// AUTO-GENERATED FILE. DO NOT EDIT.",
    "",
  ];

  if (shouldImportFlashTypes(model)) {
    lines.push(
      `import type * as ${BRIDGE_TS_TYPES_ALIAS} from "${BRIDGE_TS_TYPES_MODULE}";`,
      "",
    );
  }
  else {
    lines.push("export {};", "");
  }

  lines.push("declare global {", "  interface Window {", "    swf: {");

  for (const entry of model.exports) {
    lines.push(
      ...formatFunctionProperty(
        entry.externalName,
        entry.parameters,
        resolveRenderedReturnType(entry.returnType, entry.tsReturnType),
        "      ",
      ),
    );
  }

  lines.push("    };");

  for (const entry of model.events) {
    lines.push(
      ...formatFunctionProperty(
        entry.eventName,
        entry.parameters,
        resolveRenderedReturnType(entry.returnType, entry.tsReturnType),
        "    ",
        true,
        false,
      ),
    );
  }

  lines.push("  }", "}", "");

  return lines.join("\n");
}

async function writeOrCheckFile(
  filePath: string,
  content: string,
  check: boolean,
  repoRoot: string,
): Promise<void> {
  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf8");
  }
  catch (cause) {
    if (check) {
      throw new Error(
        `Unable to read generated file: ${relative(repoRoot, filePath)}`,
        { cause },
      );
    }
    existing = "";
  }

  if (check) {
    if (existing !== content) {
      throw new Error(`Generated file is out of date: ${relative(repoRoot, filePath)}`);
    }
    return;
  }

  if (existing === content) {
    return;
  }

  await fs.mkdir(dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

export async function generateBridgeArtifacts(
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const as3Root = join(repoRoot, "as3", "src", "lucent");
  const as3OutputPath = join(
    as3Root,
    "generated",
    "BridgeRegistryGenerated.as",
  );
  const swfDtsOutputPath = join(
    repoRoot,
    "app",
    "src",
    "renderer",
    "apps",
    "game",
    "bridge.d.ts",
  );

  const as3Files = await collectAs3Files(as3Root);
  const parsedFiles: ParsedFile[] = [];

  for (const filePath of as3Files) {
    const source = await fs.readFile(filePath, "utf8");
    parsedFiles.push(parseAs3File(filePath, source));
  }

  const model = buildBridgeModel(parsedFiles);
  const as3Registry = renderAs3Registry(model);
  const swfDts = renderWindowSwfDts(model);

  const check = options.check ?? false;
  await writeOrCheckFile(as3OutputPath, as3Registry, check, repoRoot);
  await writeOrCheckFile(swfDtsOutputPath, swfDts, check, repoRoot);

  return {
    model,
    as3Registry,
    swfDts,
    as3OutputPath,
    swfDtsOutputPath,
  };
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const result = await generateBridgeArtifacts({ check });

  if (check) {
    process.stdout.write("Bridge artifacts are up to date.\n");
    return;
  }

  process.stdout.write(
    [
      `Generated ${relative(DEFAULT_REPO_ROOT, result.as3OutputPath)}`,
      `Generated ${relative(DEFAULT_REPO_ROOT, result.swfDtsOutputPath)}`,
      `Exports: ${result.model.exports.length}`,
      `Events: ${result.model.events.length}`,
    ].join("\n") + "\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

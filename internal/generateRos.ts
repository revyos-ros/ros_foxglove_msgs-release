import type { MessageDefinition, MessageDefinitionField } from "@foxglove/message-definition";
import { ros1 } from "@foxglove/rosmsg-msgs-common";

import { FoxgloveMessageSchema, FoxglovePrimitive } from "./types";

type RosMsgFieldWithDescription = MessageDefinitionField & {
  description?: string;
};
type RosMsgDefinitionWithDescription = {
  originalName: string;
  description?: string;
  /** The name of this message type as used in .msg files (foo_msgs/Bar) */
  rosMsgInterfaceName: string;
  /** The name used to refer to this message type in ROS (foo_msgs/Bar for ROS 1, foo_msgs/msg/Bar for ROS 2) */
  rosFullInterfaceName: string;
  fields: RosMsgFieldWithDescription[];
};

function primitiveToRos(
  type: Exclude<FoxglovePrimitive, "uint32" | "bytes" | "time" | "duration">,
) {
  switch (type) {
    case "string":
      return "string";
    case "boolean":
      return "bool";
    case "float64":
      return "float64";
  }
}

function timeDurationToRos(type: "time" | "duration", { rosVersion }: { rosVersion: 1 | 2 }) {
  if (type === "time") {
    return rosVersion === 2 ? "builtin_interfaces/Time" : "time";
  } else {
    return rosVersion === 2 ? "builtin_interfaces/Duration" : "duration";
  }
}

export function generateRosMsg(
  def: RosMsgDefinitionWithDescription,
  { rosVersion }: { rosVersion: 1 | 2 },
): string {
  let source = "";
  source += `# ${def.rosFullInterfaceName}\n`;
  if (def.description != undefined) {
    source += `# ${def.description}\n`;
  }
  source += `\n# Generated by https://github.com/foxglove/schemas\n`;

  let prevFieldHadComment = true; // start true because of top-of-file comment
  for (const field of def.fields) {
    if (prevFieldHadComment || field.description != undefined) {
      source += "\n";
    }
    prevFieldHadComment = false;
    if (field.description != undefined) {
      source += field.description
        .trim()
        .split("\n")
        .map((line) => `# ${line}\n`)
        .join("");
      prevFieldHadComment = true;
    }
    let constant = "";
    if (field.isConstant === true) {
      if (field.valueText == undefined) {
        throw new Error(`Constant ${field.name} has no valueText`);
      }
      constant = `=${field.valueText}`;
    }
    let type = field.type;
    if (type === "time" || type === "duration") {
      type = timeDurationToRos(type, { rosVersion });
    }
    source += `${type}${field.isArray === true ? `[${field.arrayLength ?? ""}]` : ""} ${
      field.name
    }${constant}\n`;
  }
  return source;
}

type Dependency =
  | { type: "ros"; name: keyof typeof ros1 }
  | { type: "foxglove"; schema: FoxgloveMessageSchema };

function dependenciesEqual(a: Dependency, b: Dependency) {
  return (
    (a.type === "foxglove" && b.type === "foxglove" && a.schema.name === b.schema.name) ||
    (a.type === "ros" && b.type === "ros" && a.name === b.name)
  );
}

function* getSchemaDependencies(schema: FoxgloveMessageSchema): Iterable<Dependency> {
  for (const field of schema.fields) {
    if (field.type.type === "nested") {
      if (field.type.schema.rosEquivalent != undefined) {
        yield { type: "ros", name: field.type.schema.rosEquivalent };
        yield* getRosDependencies(ros1[field.type.schema.rosEquivalent]);
      } else {
        yield { type: "foxglove", schema: field.type.schema };
        yield* getSchemaDependencies(field.type.schema);
      }
    }
  }
}
function* getRosDependencies(schema: MessageDefinition): Iterable<Dependency> {
  for (const field of schema.definitions) {
    if (field.isComplex === true) {
      yield { type: "ros", name: field.type as keyof typeof ros1 };
      yield* getRosDependencies(ros1[field.type as keyof typeof ros1]!);
    }
  }
}

export function generateRosMsgDefinition(
  schema: FoxgloveMessageSchema,
  { rosVersion }: { rosVersion: 1 | 2 },
): RosMsgDefinitionWithDescription {
  const enumFieldNames = new Set<string>();
  const seenEnumNames = new Set<string>();

  const fields: RosMsgFieldWithDescription[] = [];
  for (const field of schema.fields) {
    let isArray = field.array != undefined;
    const arrayLength = typeof field.array === "number" ? field.array : undefined;
    let fieldType: string;
    switch (field.type.type) {
      case "enum": {
        // Add enum constants preceding the field so that Studio can pick them up:
        // https://foxglove.dev/docs/studio/annotating-data
        const enumName = field.type.enum.name;
        const valueType = "uint8";
        fieldType = valueType;
        if (seenEnumNames.has(enumName)) {
          break;
        }
        const enumFields: RosMsgFieldWithDescription[] = [];
        for (const { name, value, description } of field.type.enum.values) {
          if (enumFieldNames.has(name)) {
            throw new Error(
              `Enum value ${name} occurs in more than one enum referenced by ${schema.name}, this is not supported in ROS msg files`,
            );
          }
          if (value < 0 || value > 255 || !Number.isInteger(value)) {
            throw new Error(
              `Only uint8 enums are currently supported; value ${name}=${value} is out of range`,
            );
          }
          enumFieldNames.add(name);
          enumFields.push({
            name,
            value,
            isConstant: true,
            valueText: value.toString(),
            type: valueType,
            description,
          });
        }
        fields.push(...enumFields);
        seenEnumNames.add(enumName);
        break;
      }

      case "nested":
        if (field.type.schema.rosEquivalent != undefined) {
          fieldType = field.type.schema.rosEquivalent;
        } else {
          fieldType = `foxglove_msgs/${field.type.schema.name}`;
        }
        break;

      case "primitive":
        if (field.type.name === "bytes") {
          fieldType = "uint8";
          if (isArray) {
            throw new Error("Array of bytes is not supported in ROS msg");
          }
          isArray = true;
        } else if (field.type.name === "uint32") {
          fieldType = "uint32";
        } else if (field.type.name === "time") {
          fieldType = "time";
        } else if (field.type.name === "duration") {
          fieldType = "duration";
        } else {
          fieldType = primitiveToRos(field.type.name);
        }
        break;
    }
    fields.push({
      name: rosVersion === 2 ? field.name.toLowerCase() : field.name,
      type: fieldType,
      isComplex: field.type.type === "nested",
      isArray,
      arrayLength,
      description: field.description,
    });
  }

  return {
    originalName: schema.name,
    rosMsgInterfaceName: `foxglove_msgs/${schema.name}`,
    rosFullInterfaceName:
      rosVersion === 2 ? `foxglove_msgs/msg/${schema.name}` : `foxglove_msgs/${schema.name}`,
    description: schema.description,
    fields,
  };
}

export function generateRosMsgMergedSchema(
  schema: FoxgloveMessageSchema,
  { rosVersion }: { rosVersion: 1 | 2 },
): string {
  const dependencies: Dependency[] = [];
  for (const dep of getSchemaDependencies(schema)) {
    if (!dependencies.some((existing) => dependenciesEqual(existing, dep))) {
      dependencies.push(dep);
    }
  }

  let result = generateRosMsg(generateRosMsgDefinition(schema, { rosVersion }), { rosVersion });
  for (const dep of dependencies) {
    let name: string;
    let source: string;
    if (dep.type === "ros") {
      name = dep.name;
      source = generateRosMsg(
        {
          originalName: dep.name,
          rosMsgInterfaceName: dep.name,
          rosFullInterfaceName: dep.name,
          fields: ros1[dep.name].definitions,
        },
        { rosVersion },
      );
    } else {
      const definition = generateRosMsgDefinition(dep.schema, { rosVersion });
      name = definition.rosMsgInterfaceName;
      source = generateRosMsg(definition, { rosVersion });
    }
    result += `================================================================================\nMSG: ${name}\n${source}`;
  }
  return result;
}

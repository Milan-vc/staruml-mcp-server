---
name: staruml-database-diagram
description: Create or edit UML class diagrams for relational database schemas in StarUML. Use when a user asks for a database UML diagram, database class model, or an entity-and-relation schema represented as UML; do not use for general software class diagrams.
---

# StarUML Database Diagrams

Create the requested database diagram with the StarUML MCP. Use no other diagramming or image-generation tool to create, edit, or render it.

## Workflow

1. Identify the classes, attributes, primary keys, foreign keys, and relations from the user's requirements.
2. Resolve any direct many-to-many relation by adding an association class/table with appropriate primary and foreign keys.
3. Number relations sequentially in diagram order as `R1`, `R2`, `R3`, and so on.
4. Label every foreign key as `FK<n>`, where `<n>` is the number of the relation it implements. Verify that each foreign key references the class at the other end of that relation.
5. Build or update the diagram in StarUML, then inspect it for compliance with every convention below.

If a missing cardinality, optionality, or key choice would materially change the schema, ask the user. Otherwise make the smallest reasonable assumption and state it concisely.

## Naming and attributes

- Use PascalCase for class names and camelCase for attribute names.
- Write every attribute as `<attributeName>: <type> <markers>`.
- Allowed attribute types are only `int`, `float`, `bool`, `string`, `date`, `time`, and `datetime`. Write types in lowercase.
- Mark primary keys with `PK`. Do not add `NA` or `NNA` to primary keys because they are always null-not-allowed.
- For every non-primary-key attribute, add exactly one nullability marker:
  - `NA` for null allowed.
  - `NNA` for null not allowed.
- Mark foreign keys with `FK<n>` using the matching relation number. A foreign key may also be `NA` or `NNA` according to the relation's optionality.

## Relations

- Give every relation a visible sequential label: `R1`, `R2`, `R3`, and so on.
- Show optionality at both ends of every relation.
- Use only `0..1`, `0..*`, and `1..1` as endpoint multiplicities.
- Never draw a direct many-to-many relation. Replace it with an association class/table and two relations, each with its own sequential number and matching foreign key.

## Required output pattern

Use this notation in the StarUML model:

```text
User
userId: int PK
firstName: string NNA
lastName: string NNA
userGroupId: int FK1 NA

UserGroup
userGroupId: int PK
groupName: string NNA

R1
User 0..* --- 0..1 UserGroup
```

Treat the example as a notation guide, not as schema content to copy into unrelated diagrams.

## **Layout and relation lines**

- Arrange classes in a clean, grid-based layout with consistent spacing and alignment.
- **Relation lines must never overlap classes, attributes, or other relation lines**, except where lines intentionally meet at a shared endpoint.
- Use only straight-line segments with right-angle bends (orthogonal routing). Never use smooth, curved, rounded, or spline-style connectors.
- Route relation lines around classes and other connectors. Use additional right-angle bends when necessary to avoid collisions.
- Minimize line crossings. If crossings cannot be avoided, rearrange the classes before accepting them.
- Keep relation labels (`R1`, `R2`, etc.) visible and separate from other labels and lines.
- Place multiplicities (`0..1`, `0..*`, `1..1`) close to their respective endpoints without overlapping class borders or other text.
- Keep foreign-key attributes visually associated with their corresponding relations without letting connectors cross through class contents.
- Prefer placing association classes between the classes they connect, with sufficient room for both relations.
- After creating the diagram, inspect the complete layout and reposition classes and reroute connectors until the diagram is readable and free of avoidable overlaps.
- Do not consider the diagram complete until both the schema conventions and the visual layout requirements have been checked.
- Use StarUML's orthogonal or rectilinear connector type when available. Do not approximate orthogonal routing using curved connectors.
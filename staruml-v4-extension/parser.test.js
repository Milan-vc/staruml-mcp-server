'use strict'

const assert = require('assert')
const bridge = require('./main')

const brace = bridge._parseClassDiagram([
  'classDiagram',
  'class User {',
  '  userId: int PK',
  '  display name: string NNA',
  '}',
  'class UserGroup {',
  '  userGroupId: int PK',
  '}',
  'User "0..*" -- "0..1" UserGroup : R1'
].join('\n'))

assert.deepStrictEqual(
  brace.classes.map(function (item) { return item.name }),
  ['User', 'UserGroup']
)
assert.deepStrictEqual(
  brace.classes[0].attributes,
  ['userId: int PK', 'display name: string NNA']
)
assert.strictEqual(brace.relations[0].name, 'R1')
assert.strictEqual(brace.relations[0].leftEnd.multiplicity, '0..*')
assert.strictEqual(brace.relations[0].rightEnd.multiplicity, '0..1')

const plain = bridge._parseClassDiagram([
  'classDiagram',
  'User',
  'userId: int PK',
  'firstName: string NNA',
  '',
  'UserGroup',
  'userGroupId: int PK',
  '',
  'R1',
  'User 0..* --- 0..1 UserGroup'
].join('\n'))

assert.deepStrictEqual(
  plain.classes.map(function (item) { return item.name }),
  ['User', 'UserGroup']
)
assert.strictEqual(plain.relations[0].name, 'R1')
assert.strictEqual(plain.relations[0].token, '--')

const spaced = bridge._parseClassDiagram([
  'classDiagram',
  'class "User Group" {',
  '  group name: string NNA',
  '}',
  '"User Group" "1..1" -- "0..*" User : R2'
].join('\n'))

assert.strictEqual(spaced.classes[0].name, 'User Group')
assert.strictEqual(spaced.classes[0].attributes[0], 'group name: string NNA')
assert.strictEqual(spaced.relations[0].left, 'User Group')

assert.strictEqual(bridge._memberName('userId: int PK'), 'userId: int PK')
assert.strictEqual(bridge._lineStyleValue(), 4)
assert.strictEqual(bridge._lineStyleValue('direct'), 4)
assert.strictEqual(bridge._lineStyleValue('rectilinear'), 0)
assert.strictEqual(bridge._lineStyleValue('curve'), 3)
assert.strictEqual(bridge._layoutDirectionValue('top-to-bottom'), 'TB')
assert.deepStrictEqual(
  bridge._findRelationshipStyle(
    { name: 'R1', left: 'User', right: 'Group' },
    [
      { source: 'Other', target: 'Thing', lineStyle: 'curve' },
      { name: 'R1', lineStyle: 'direct' }
    ]
  ),
  { name: 'R1', lineStyle: 'direct' }
)

assert.throws(function () {
  bridge._lineStyleValue('wobbly')
}, /Unsupported line style/)

assert.throws(function () {
  bridge._parseClassDiagram([
    'classDiagram',
    'class User {',
    '  id: int PK',
    '}',
    'User 0..* ---- 0..1 Group'
  ].join('\n'))
}, /Unsupported/)

console.log('Parser regression tests passed.')

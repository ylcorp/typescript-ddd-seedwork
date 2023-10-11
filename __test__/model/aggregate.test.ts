import { randomUUID } from 'crypto';
import { apply } from 'fp-ts/lib/function';
import { Arr, S } from '@logic/fp';
import {
  AggBehavior,
  AggregateRoot,
  BehaviorMonadTrait,
  DomainEventTrait,
  Either,
  Entity,
  Identifier,
  Optics,
  Option,
  identityInvariantParser,
  pipe,
  EntityTrait,
  EntityLiken,
  parseString,
  parseNumber,
  parseArray,
  getEntityEq,
} from 'src';
import { AggregateLiken, AggregateTrait } from '@model/aggregate-root.base';
import { omit } from 'ramda';

type ExampleEntity = Entity<{ a: string }>;

class ExampleEntityTrait extends EntityTrait<ExampleEntity> {
  parse = parseExampleEntity;
  new = parseExampleEntity;
}

const exampleEntityTrait = new ExampleEntityTrait();

const parseExampleEntityProps = (v: EntityLiken<ExampleEntity>) =>
  exampleEntityTrait.structParsingProps({
    a: Either.right(String(v.a)),
  });

const parseExampleEntity = (v: EntityLiken<ExampleEntity>) =>
  exampleEntityTrait.factory(parseExampleEntityProps)('exampleEntity')(v);

const constructExampleEntityProps = (id: string) => ({
  id,
  createdAt: new Date(),
  updatedAt: Option.some(new Date()),
  a: '',
});

type ExampleAProps = {
  attr1: string;
  attr2: number;
  attrArrayPrimitive: string[];
  attrArrayEntities: ExampleEntity[];
};

type ExampleA = AggregateRoot<ExampleAProps>;

const parseExampleAProps = (v: AggregateLiken<ExampleA>) =>
  exampleATrait.structParsingProps({
    attr1: parseString(v.attr1),
    attr2: parseNumber(v.attr2),
    attrArrayPrimitive: pipe(
      parseArray<string>,
      apply(parseString),
      apply(v.attrArrayPrimitive),
    ),
    attrArrayEntities: pipe(
      parseArray<ExampleEntity>,
      apply(exampleEntityTrait.parse),
      apply(v.attrArrayEntities),
    ),
  });
const parseExample = (v: AggregateLiken<ExampleA>) =>
  exampleATrait.factory(parseExampleAProps)('exampleA')(v);

class ExampleATrait extends AggregateTrait<ExampleA> {
  parse = parseExample;
  new = parseExample;
}

const exampleATrait = new ExampleATrait();

const constructA = (
  attr1: string,
  attr2: number,
  attrArrayPrimitive: string[] = [],
  attrArrayEntities: EntityLiken<ExampleEntity>[] = [],
) => {
  return exampleATrait.parse({
    attr1,
    attr2,
    attrArrayEntities,
    attrArrayPrimitive,
    createdAt: new Date(),
    updatedAt: Option.some(new Date()),
    id: randomUUID(),
  });
};

describe('Test Aggregate', () => {
  it('test behavior', () => {
    const events = (a: ExampleA) => [
      DomainEventTrait.construct({
        aggregateId: exampleATrait.id(a),
        aggregateType: 'exampleA',
        name: 'EVENT_1',
      }),
    ];
    const changeAttr1: AggBehavior<ExampleA, void, false> =
      () => (a: ExampleA) => {
        return pipe(
          a,
          Optics.replace(exampleATrait.propsLen().at('attr1'))('attr1_updated'),
          (updatedA: ExampleA) => BehaviorMonadTrait.of(updatedA, events(a)),
        );
      };

    pipe(
      constructA('attr1', 2),
      Either.map(changeAttr1()),
      Either.map((bhm) => {
        const [state, bEvents] = bhm([]);
        expect(state.props.attr1).toEqual('attr1_updated');
        expect(omit(['metadata'], bEvents[0])).toStrictEqual(
          omit(['metadata'], events(state)[0]),
        );
      }),
      Either.mapLeft((e) => {
        console.log('error ', e);
        fail();
      }),
    );
  });

  it('test setter', () => {});

  describe('test remover, adder', () => {
    const testAgg = constructA(
      'attr1',
      2,
      ['a', 'b'],
      [
        constructExampleEntityProps('id1'),
        constructExampleEntityProps('id2'),
        constructExampleEntityProps('id3'),
      ],
    );
    it('test adder with primitives array', () => {
      pipe(
        testAgg,
        Either.flatMap((agg) =>
          pipe(
            exampleATrait.adder<string>,
            apply('attrArrayPrimitive' as keyof ExampleA['props']),
            apply({
              E: S.Eq,
              validator: identityInvariantParser,
              events: [
                DomainEventTrait.construct({
                  aggregateId: exampleATrait.id(agg),
                  aggregateType: testAgg._tag,
                  name: 'ADD_ARRAY_PRIMITIVE',
                }),
              ],
            }),
            apply('hau<3nga'),
            apply(agg),
          ),
        ),
        Either.fold(
          (e) => {
            throw e;
          },
          (bMonad) => {
            const [a, e] = bMonad([]);
            expect(a.props.attrArrayPrimitive).toContain('hau<3nga');
            expect(e).toHaveLength(1);
          },
        ),
      );
    });
    describe('test remover with primitives array', () => {
      const remover = pipe(
        exampleATrait.remover<string>,
        apply('attrArrayPrimitive' as keyof ExampleA['props']),
        apply({
          E: S.Eq,
          validator: identityInvariantParser,
          events: [
            DomainEventTrait.construct({
              aggregateId: pipe(
                testAgg,
                Either.map(exampleATrait.id),
                Either.getOrElse(() => 'unknown' as Identifier),
              ),
              aggregateType: testAgg._tag,
              name: 'REMOVE_ARRAY_PRIMITIVE',
            }),
          ],
        }),
      );
      it('remove existing element', () => {
        pipe(
          testAgg,
          Either.flatMap((agg) => pipe(remover, apply('a'), apply(agg))),
          Either.fold(
            (e) => {
              throw e;
            },
            (bMonad) => {
              const [a, e] = bMonad([]);
              expect(a.props.attrArrayPrimitive).not.toContain('a');
              expect(e).toHaveLength(1);
            },
          ),
        );
      });
      it('remove not existing element', () => {
        pipe(
          testAgg,
          Either.flatMap((agg) => pipe(remover, apply('aaa'), apply(agg))),
          Either.fold(
            (e) => {
              expect(e).toHaveLength(1);
            },
            (bMonad) => {
              fail();
            },
          ),
        );
      });
    });
    it('test adder with domain model entity array', () => {
      pipe(
        Either.Do,
        Either.bind('agg', () => testAgg),
        Either.bind('newEntity', () =>
          exampleEntityTrait.parse(constructExampleEntityProps('newEntity')),
        ),
        Either.flatMap(({ agg, newEntity }) =>
          pipe(
            pipe(
              exampleATrait.adder<ExampleEntity>,
              apply('attrArrayEntities' as keyof ExampleA['props']),
              apply({
                E: getEntityEq<ExampleEntity>(),
                validator: identityInvariantParser,
                events: [
                  DomainEventTrait.construct({
                    aggregateId: exampleATrait.id(agg),
                    aggregateType: agg._tag,
                    name: 'ADD_ARRAY_ENTITY',
                  }),
                ],
              }),
              apply(newEntity),
              apply(agg),
            ),
            Either.bimap(
              (e) => {
                console.log('error ', e);
                fail();
              },
              (bMonad) => {
                const [a, e] = bMonad([]);
                expect(
                  pipe(
                    a.props.attrArrayEntities,
                    Arr.some((_a: ExampleEntity) => {
                      return getEntityEq<ExampleEntity>().equals(_a, newEntity);
                    }),
                  ),
                ).toBeTruthy();
                expect(e).toHaveLength(1);
              },
            ),
          ),
        ),
      );
    });
  });
});

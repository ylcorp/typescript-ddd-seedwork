import {
  Liken,
  Parser,
  ParsingInput,
  Validation,
  structSummarizerParsing,
} from './invariant-validation';
import {
  Arr,
  Either,
  Eq,
  IoTypes,
  NEA,
  Optics,
  Option,
  ReadonlyRecord,
  S,
  io,
} from '@logic/fp';
import { apply, pipe } from 'fp-ts/lib/function';
import { DomainEvent } from './event';
import { BehaviorMonadTrait } from './domain-behavior.monad';
import { BaseExceptionBhv } from '@logic/exception.base';
import { shouldBeArray } from '@logic/parser';
import { Brand } from '@type_util/index';
import { PrimitiveVOTrait } from './value-object.base';
import { DomainModel, DomainModelTrait } from './domain-model.base';
import { FirstArgumentType } from '@type_util/function';

export type Identifier = Brand<string, 'Identifier'>;

export const parseId: Parser<Identifier> = (v: unknown) => {
  const isId = (v: unknown): v is Identifier =>
    typeof v === 'string' && v.length > 0;
  return Either.fromPredicate(isId, () =>
    BaseExceptionBhv.construct('invalid identifier', 'INVALID_IDENTIFIER'),
  )(v);
};

export const IdentifierTrait: PrimitiveVOTrait<Identifier> = {
  parse: parseId,
  new: parseId,
};

export interface Entity<
  T extends ReadonlyRecord.ReadonlyRecord<string, any> = unknown,
> extends DomainModel<T> {
  readonly props: T;
  readonly id: Identifier;
  readonly createdAt: Date;
  readonly updatedAt: Option.Option<Date>;
}

type EntityCommonProps = Omit<Entity, 'props'>;

export type EntityLiken<T extends Entity> = Liken<
  Omit<EntityCommonProps, '_tag'>
> & {
  [K in keyof T['props']]: T['props'][K] extends Entity
    ? EntityLiken<T['props'][K]>
    : T['props'][K] extends Array<unknown> & { [key: number]: Entity }
    ? EntityLiken<T['props'][K][0]>[]
    : Liken<T['props'][K]>;
};

const construct =
  <T extends Entity>(parser: Parser<T['props']>) =>
  (tag: string) =>
  (props: unknown) => {
    const MetaLikeParser = io.type({
      id: io.string,
      createdAt: IoTypes.fromNullable(IoTypes.date, new Date()),
      updatedAt: IoTypes.fromNullable(
        IoTypes.option(IoTypes.date),
        Option.none,
      ),
    });

    const parserMetaLike = (v: unknown) =>
      pipe(
        v,
        MetaLikeParser.decode,
        Either.flatMap((metaLike) => {
          return structSummarizerParsing<Omit<EntityCommonProps, '_tag'>>({
            id: parseId(metaLike.id),
            createdAt: Either.right(metaLike.createdAt),
            updatedAt: Either.right(metaLike.updatedAt),
          });
        }),
      );

    return pipe(
      Either.Do,
      Either.bind('meta', () => parserMetaLike(props)),
      Either.bind('props', () => parser(props)),
      Either.map(
        ({ props, meta }) =>
          ({
            id: meta.id,
            _tag: tag,
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
            props,
          } as T),
      ),
    );
  };

const idLens = <T extends Entity>() => Optics.id<T>().at('id');

const id = <T extends Entity>(state: T) =>
  pipe(state, Optics.get(idLens<T>())) as Identifier;

const setId =
  <T extends Entity>(id: Identifier) =>
  (state: T) => {
    return pipe(state, Optics.replace(idLens<T>())(id));
  };

const entityMetaLens = <T extends Entity>(key: keyof EntityCommonProps) =>
  Optics.id<T>().at(key);

const entityPropsLen = <A extends Entity>() =>
  Optics.id<A>().at('props') as Optics.Lens<A, A['props']>;

const createdAt = <T extends Entity>(state: T) =>
  pipe(state, Optics.get(entityMetaLens('createdAt'))) as Date;

const updatedAt = <T extends Entity>(state: T) =>
  pipe(state, Optics.get(entityMetaLens('updatedAt')));

const markUpdate = <T extends Entity>(state: T) =>
  pipe(state, Optics.replace(entityMetaLens('updatedAt'))(new Date()));

export type Query<T extends Entity, A> = (entity: T) => A;
export type QueryOpt<T extends Entity, A> = (entity: T) => Option.Option<A>;

export type InvariantParser<
  T extends Entity,
  IsPropAttr extends boolean,
  V extends IsPropAttr extends true ? T['props'][keyof T['props']] : unknown,
> = (entity: T) => Parser<V>;

export const identityInvariantParser =
  <T extends Entity, V extends T['props'][keyof T['props']]>() =>
  (v: V) =>
    Either.of(v);

const setter =
  <T extends Entity, V extends T['props'][keyof T['props']]>(
    attributeName: keyof T['props'],
  ) =>
  (validator: InvariantParser<T, true, V>, events: DomainEvent[]) =>
  (newV: unknown) =>
  (entity: T) => {
    return pipe(
      newV,
      validator(entity),
      Either.map((v) =>
        pipe(
          Optics.replace(entityPropsLen<T>().at(attributeName)),
          apply(v),
          apply(entity),
          (updatedEntity: T) => BehaviorMonadTrait.of(updatedEntity, events),
        ),
      ),
    );
  };

const adder =
  <T extends Entity, A>(attributeName: keyof T['props']) =>
  ({
    E,
    validator,
    events,
  }: {
    E: Eq.Eq<A>;
    validator: InvariantParser<T, false, A>;
    events: DomainEvent[];
  }) =>
  (newItem: A) =>
  (entity: T) => {
    const lens = entityPropsLen<T>().at(attributeName);
    const getAttr = Optics.get(lens);
    const validating = () => pipe(validator, apply(entity), apply(newItem));
    const mustNotExist = (arr: A[]) =>
      Either.fromPredicate(
        (a: A) => {
          return !Arr.elem(E)(a)(arr);
        },
        () =>
          NEA.of(BaseExceptionBhv.construct('Item existed', 'ITEM_EXISTED')),
      );
    return pipe(
      entity,
      getAttr,
      shouldBeArray<A>({
        message: `property ${attributeName as string} should be an array`,
        code: 'PROP_NOT_ARRAY',
      }),
      Either.bindTo('array'),
      Either.bind('item', validating),
      Either.tap(({ item, array }) =>
        pipe(mustNotExist, apply(array), apply(item)),
      ),
      Either.flatMap(({ item, array }) =>
        Either.tryCatch(
          () =>
            Optics.replace(lens)([
              ...array,
              item,
            ] as T['props'][keyof T['props']])(entity) as T,
          (e: Error) =>
            NEA.of(
              BaseExceptionBhv.construct(
                e.message,
                'ADDER_OPTICS_CHANGE_ERROR',
              ),
            ),
        ),
      ),
      Either.map((updatedEntity) =>
        BehaviorMonadTrait.of(updatedEntity, events),
      ),
    );
  };

const remover =
  <T extends Entity, A>(attributeName: keyof T['props']) =>
  ({
    E,
    validator,
    events,
  }: {
    E: Eq.Eq<A>;
    validator: InvariantParser<T, false, A>;
    events: DomainEvent[];
  }) =>
  (removedItem: A) =>
  (entity: T) => {
    const lens = entityPropsLen<T>().at(attributeName);
    const getAttr = Optics.get(lens);
    const validating = () => pipe(validator, apply(entity), apply(removedItem));
    const mustExist = (arr: A[]) => (checkedItem: A) =>
      pipe(
        arr,
        Arr.findIndex((a) => E.equals(a, checkedItem)),
        Either.fromOption(() =>
          NEA.of(
            BaseExceptionBhv.construct(
              'Item does not existed',
              'ITEM_NOT_EXISTED',
            ),
          ),
        ),
      );
    return pipe(
      entity,
      getAttr,
      shouldBeArray<A>({
        message: `property ${attributeName as string} should be an array`,
        code: 'PROP_NOT_ARRAY',
      }),
      Either.bindTo('array'),
      Either.bind('item', validating),
      Either.bind('idx', ({ item, array }) =>
        pipe(mustExist, apply(array), apply(item)),
      ),
      Either.map(({ array, idx }) =>
        pipe(Arr.deleteAt, apply(idx), apply(array)),
      ),
      Either.flatMap((updatedArray) =>
        Either.tryCatch(
          () =>
            Optics.replace(lens)(updatedArray as T['props'][keyof T['props']])(
              entity,
            ) as T,
          (e: Error) =>
            NEA.of(
              BaseExceptionBhv.construct(
                e.message,
                'ADDER_OPTICS_CHANGE_ERROR',
              ),
            ),
        ),
      ),
      Either.map((updatedEntity) =>
        BehaviorMonadTrait.of(updatedEntity, events),
      ),
    );
  };

export const getEntityEq = <T extends Entity<unknown>>() =>
  Eq.contramap((entity: T) => ({
    tag: entity._tag,
    id: entity.id,
  }))(
    Eq.struct({
      tag: S.Eq,
      id: S.Eq,
    }),
  );

const isEqual = <T extends Entity>(entityLeft: T, entityRight: T) =>
  getEntityEq<T>().equals(entityLeft, entityRight);

const getSnapshot = <T>(state: Entity<T>) =>
  ReadonlyRecord.fromRecord({
    createdAt: state.createdAt,
    updatedAt: state.createdAt,
    id: state.id,
    ...state.props,
  });

export abstract class EntityTrait<
  E extends Entity,
> extends DomainModelTrait<E> {
  abstract parse: Parser<E>;
  abstract new: (params: unknown) => Validation<E>;
  factory = construct<E>;
  id = id<E>;
  setId = setId<E>;
  createdAt = createdAt<E>;
  updatedAt = updatedAt<E>;
  markUpdate = markUpdate<E>;
  getSnapshot = getSnapshot<E>;
  isEqual = isEqual<E>;
  remover = <V>(a: FirstArgumentType<typeof remover<E, V>>) => remover<E, V>(a);
  adder = <V>(a: FirstArgumentType<typeof adder<E, V>>) => adder<E, V>(a);
  setter = <V extends E['props'][keyof E['props']]>(
    a: FirstArgumentType<typeof setter<E, V>>,
  ) => setter<E, V>(a);
  propsLen = entityPropsLen<E>;
  structParsingProps = structParsingProps<E>;
}

export const structParsingProps = <ET extends Entity>(
  raw: ParsingInput<ET['props']>,
) => structSummarizerParsing<ET['props']>(raw);

export const getGenericTrait = <E extends Entity>() => ({
  factory: construct<E>,
  id: id<E>,
  setId: setId<E>,
  createdAt: createdAt<E>,
  updatedAt: updatedAt<E>,
  markUpdate: markUpdate<E>,
  getSnapshot: getSnapshot<E>,
  isEqual: isEqual<E>,
  remover: <V>(a: FirstArgumentType<typeof remover<E, V>>) => remover<E, V>(a),
  adder: <V>(a: FirstArgumentType<typeof adder<E, V>>) => adder<E, V>(a),
  setter: <V extends E['props'][keyof E['props']]>(
    a: FirstArgumentType<typeof setter<E, V>>,
  ) => setter<E, V>(a),
  propsLen: entityPropsLen<E>,
  structParsingProps: structParsingProps<E>,
});

// This is the type of the data structure that the lens will be operating on.
interface Whole {
  readonly a: string;
  readonly b: number;
  readonly c: boolean;
}

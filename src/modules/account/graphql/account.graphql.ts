/** GraphQL field `me`: the signed-in account (ADR-0015). */
import { builder } from '../../../graphql/builder.js';
import type { AppUser } from '../model/user.model.js';

const User = builder.objectRef<AppUser>('User').implement({
  description: 'The signed-in account.',
  fields: (fieldBuilder) => ({
    id: fieldBuilder.exposeID('id'),
    isOperator: fieldBuilder.exposeBoolean('isOperator'),
  }),
});

builder.queryField('me', (fieldBuilder) =>
  fieldBuilder.field({
    type: User,
    description: 'The account making this request.',
    resolve: (_root, _args, ctx) => ctx.user,
  }),
);

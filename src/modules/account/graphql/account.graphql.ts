import { builder } from '../../../graphql/builder.js';
import type { AppUser } from '../model/user.model.js';

const User = builder.objectRef<AppUser>('User').implement({
  description: 'The signed-in account.',
  fields: (t) => ({
    id: t.exposeID('id'),
    isOperator: t.exposeBoolean('isOperator'),
  }),
});

builder.queryField('me', (t) =>
  t.field({
    type: User,
    description: 'The account making this request.',
    resolve: (_root, _args, ctx) => ctx.user,
  }),
);

import * as schema from "./schema"
import { defineRelations } from "drizzle-orm";



export const relations = defineRelations(schema, (r) => ({
    user: {
        sessions: r.many.session(),
        accounts: r.many.account(),
    },
    session: {
        user: r.one.user({
            from: r.session.userId,
            to: r.user.id,
        }),
    },
    account: {
        user: r.one.user({
            from: r.account.userId,
            to: r.user.id,
        }),
    },
    owner: {
        files: r.one.user({
            from: r.objects.ownerId,
            to: r.user.id,

        })
    },
    objects: {
        owner: r.many.objects()
    }
}));

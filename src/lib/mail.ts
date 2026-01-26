import { env } from "cloudflare:workers";
import { Resend } from "resend";

export const resend = new Resend(env.RESEND_SECRET);

export const sendEmail = async ({ to, subject, text }: { to: string, subject: string, text: string }) => {
    await resend.emails.send({
        from: "noreply@mail.kratuwus.co",
        to,
        subject,
        text,
    });
};
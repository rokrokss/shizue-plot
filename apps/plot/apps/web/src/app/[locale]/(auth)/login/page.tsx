import { AuthForm } from '@/components/AuthForm';

/**
 * `next` is read here rather than in the form: the gate that sent the reader
 * away put it in the URL, and reading it on the server keeps the page one
 * render — no suspense boundary, no empty markup while the query arrives.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[] }>;
}) {
  const { next, error } = await searchParams;
  return <AuthForm next={next} error={error} />;
}

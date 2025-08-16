import { getSession } from "@/lib/auth";
import AuthProvider from "./AuthProvider";
import { Toaster } from "sonner";
import ProgressBar from "@/lib/ProgressBar";

export default async function SessionWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  return (
    <AuthProvider session={session}>
      <Toaster richColors position="top-center" />
      <ProgressBar />
      {children}
    </AuthProvider>
  );
}
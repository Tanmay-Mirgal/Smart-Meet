import { Providers } from "@/components/providers";

export default function MeetingRoomLayout({ children }: { children: React.ReactNode }) {
  return <Providers>{children}</Providers>;
}

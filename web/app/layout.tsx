import './globals.css';

export const metadata = {
  title: 'Orvia Revision 3 · Control Center',
  description: 'Orvia Revision 3 多 Agent 协作控制中心',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

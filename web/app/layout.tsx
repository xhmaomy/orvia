import './globals.css';

export const metadata = {
  title: 'Orvia v3.1 · Control Center',
  description: 'Orvia v3.1 多 Agent 协作控制中心',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

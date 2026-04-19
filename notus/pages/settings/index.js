export async function getServerSideProps() {
  return {
    redirect: {
      destination: '/settings/model',
      permanent: false,
    },
  };
}

export default function SettingsIndexPage() {
  return null;
}

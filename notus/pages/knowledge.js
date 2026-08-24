export function getServerSideProps() {
  return {
    redirect: {
      destination: '/files',
      permanent: false,
    },
  };
}

export default function KnowledgeRedirect() {
  return null;
}

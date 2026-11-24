# Gestão de Portarias · Secretaria de Administração · São José do Egito

Site com login, cadastro de portarias, upload do PDF assinado, quadro de números e busca.
Funciona no **Netlify** (plano gratuito): o site fica em `public/`, o servidor em `netlify/functions/api.mjs`
e os dados/PDFs ficam guardados no **Netlify Blobs** (já incluso, não precisa configurar nada).

## Como publicar (uma vez só)

1. Crie um repositório novo no GitHub (ex.: `gestao-portarias`) e envie **todo o conteúdo desta pasta**
   (netlify.toml, package.json, pasta `public`, pasta `netlify`).
2. No Netlify: **Add new site → Import an existing project → GitHub** e escolha o repositório.
   Não mude nada nas opções (o `netlify.toml` já traz tudo) e clique em **Deploy**.
3. Quando terminar, abra o endereço do site (algo como `https://nome-escolhido.netlify.app`;
   dá para trocar o nome em *Site configuration → Change site name*).
4. Na primeira abertura aparece **Primeiro acesso**: crie o login e a senha do administrador.
   (Faça isso logo após publicar, antes de divulgar o link.)
   *Opcional, mais seguro:* em *Site configuration → Environment variables* crie `SETUP_CODE` com um código
   seu; a tela de primeiro acesso passa a pedir esse código.
5. Em **Administração → Importar portarias**, cole o **Backup** do Sistema da Secretaria (ou envie o arquivo).
   As portarias já cadastradas entram na ordem do menor para o maior número.
6. Em **Administração → Usuários**, cadastre quem preenche (perfil *Preenche portarias*) e quem só consulta
   (*Somente consulta*). Marque **Controle do RH** em quem pode marcar "entregue ao RH".

## Perfis

| Perfil | Pode |
|---|---|
| Administrador | Tudo: usuários, importar, ver acessos, excluir portarias |
| Preenche portarias | Cadastrar e editar portarias, anexar PDFs (e marcar RH, se tiver "Controle do RH") |
| Somente consulta | Buscar, ver o quadro de números e baixar PDFs |

## Observações

- PDFs: até 5 MB cada (portaria assinada e PDF da publicação).
- Atualizações: ao enviar mudanças para o GitHub, o Netlify republica sozinho; os dados não se perdem.
- Testar no computador: `node test/dev-server.mjs` e abrir http://localhost:8787 (usa memória, nada é salvo).

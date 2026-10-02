# Empréstimo de Cadeira de Rodas — Jardim Botânico

PWA para registrar empréstimos de cadeira de rodas e controlar, em tempo real, as cadeiras que ainda estão em uso.

## Como os dados são tratados

- Enquanto o empréstimo está ativo, solicitante, CPF e telefone ficam no controle temporário do Apps Script para identificação no painel.
- Ao confirmar a devolução, esses dados são removidos do controle ativo.
- A planilha recebe somente os dados institucionais definidos: datas, atendente, situação, procedência/origem, motivação, como ficou sabendo, horários, permanência, observações e ID do empréstimo.
- Sem internet, o navegador mantém uma fila local de novos empréstimos e devoluções e a envia quando voltar a ficar online.

## Publicação

1. No Apps Script vinculado à planilha `1KsauWfpoX65MVml9GE5BiOGj1XZd9Mo_47Qn833-EmM`, crie um arquivo `code.gs` e cole o conteúdo deste projeto.
2. Implante como **Web app**, executando como sua conta e com acesso compatível com a equipe que usará o aplicativo. Copie a URL final terminada em `/exec`.
3. No arquivo `app.js`, substitua `COLE_AQUI_A_URL_DO_WEB_APP_EXEC` pela URL copiada.
4. Publique todos os arquivos desta pasta em uma pasta do GitHub Pages. A origem autorizada no `code.gs` é `https://dadosturismo.github.io`.
5. Abra o endereço publicado pelo celular ou computador. O navegador oferecerá a instalação como aplicativo quando suportado.

Na primeira devolução, o sistema cria automaticamente a aba **Empréstimos Cadeira de Rodas** e seus cabeçalhos na planilha.

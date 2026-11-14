# Cachalot: regras para agentes

## Extensão do Chrome: sempre sincronizar depois de mexer

O Chrome desta máquina **não** carrega a extensão de `extension/chrome`, e sim de uma cópia em
`%LOCALAPPDATA%\SwissTechKnife\data\vd-get\extensao-chrome`. Toda vez que alterar qualquer arquivo de
`extension/chrome` (fora de `tests/` e `scripts/`), rode ao terminar:

```powershell
powershell -File stk/scripts/sync-extension.ps1
```

e avise o usuário para clicar em atualizar a extensão em `chrome://extensions`.

## Módulo: instalar no SwissTechKnife depois de mexer

Se a mudança envolver o módulo (`stk/Cachalot.Module`, `servidor.py` e demais `.py` do backend, por exemplo uma
rota nova da ponte ou um campo novo em `GET /downloads`), só o refresh da extensão não basta. Quando o usuário
pedir para instalar, rode:

```powershell
powershell -File stk/scripts/install-local.ps1
```

Ele compila o Release, copia por cima da versão instalada, reinicia o SwissTechKnife na área de notificação e
sincroniza a extensão.

## Sessões do app Claude (MSIX): `%LOCALAPPDATA%` virtualizado

Shells deste app enxergam `%LOCALAPPDATA%` virtualizado: arquivos novos vão para uma cópia privada do pacote e o
que se lê pode ser uma cópia velha (ex.: `state.json` do SwissTechKnife). Os dois scripts acima já rodam a parte de
arquivos num processo criado via WMI, fora do pacote. Nunca inicie o SwissTechKnife direto de um shell daqui
(`Start-Process`); use os scripts. Detalhes: `ERRORS.md` (-16).

Mais detalhes de build e arquitetura: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

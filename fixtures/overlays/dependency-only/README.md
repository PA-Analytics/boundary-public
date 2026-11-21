# Overlay `dependency-only`

Se copia encima de `fixtures/broken-repo` para el escenario del benchmark en el que
**solo** falta la dependencia `boundary-cost-tools@1.4.2`: `lib/` va sin los defectos
sembrados, así que la suite de aceptación pasa en cuanto la dependencia se materializa.
Sirve para medir la continuidad pura (recuperación) sin mezclarla con la calidad de
reparación de código, que mide el escenario `repair` sobre el fixture completo.

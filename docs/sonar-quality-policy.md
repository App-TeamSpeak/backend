# Política de calidad para SonarQube Cloud

El repositorio ya está configurado para esperar el resultado del Quality Gate con
`sonar.qualitygate.wait=true`. La política se define en SonarQube Cloud, no en el
archivo `sonar-project.properties`.

## Quality Gate recomendado

Configurar un gate basado en **New Code** con estas condiciones:

| Condición | Umbral |
| --- | --- |
| Bugs nuevos | 0 |
| Vulnerabilidades nuevas | 0 |
| Security Hotspots nuevos revisados | 100% |
| Rating de confiabilidad en código nuevo | A |
| Rating de seguridad en código nuevo | A |
| Rating de mantenibilidad en código nuevo | A |
| Cobertura en código nuevo | >= 80% |
| Duplicación en código nuevo | <= 3% |

## Configuración del proyecto

En SonarQube Cloud:

1. Abrir el proyecto `TeamSpeak Backend`.
2. Ir a **Project Settings > Quality Gate**.
3. Seleccionar el gate estricto o crear uno con las condiciones anteriores.
4. En **Administration > General Settings > New Code**, usar `main` como rama de
   referencia si la interfaz ofrece esa opción.
5. En GitHub, activar la protección de la rama `main` y exigir el check de
   SonarCloud antes de hacer merge.

El workflow genera y verifica los reportes `lcov.info` de los dos servicios antes
de lanzar SonarCloud. Si falta cobertura, el job falla antes del análisis; si el
análisis no cumple el Quality Gate, el scanner también falla el workflow.

La cobertura global actual no se usa como excusa para ocultar deuda técnica: el
gate se aplica sobre el código nuevo y los archivos fuente siguen incluidos en el
análisis.

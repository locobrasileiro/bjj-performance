# 🥋 BJJ Performance

> **Plataforma web de alto rendimiento físico enfocada en Jiu-Jitsu Brasileño.**  
> Transforma el seguimiento tradicional basado en Excel en una aplicación completa, moderna y colaborativa con control antropométrico, progresión de fuerza relativa, estimación de $VO_2$ máx y comunidad.

---

## 📋 Visión Ejecutiva y Metodología

### 🎯 Propósito del Proyecto
**BJJ Performance** nace para centralizar, estructurar y facilitar la gestión del entrenamiento físico en atletas de BJJ. La app reemplaza las complejas hojas de cálculo por una interfaz ágil orientada al usuario, garantizando la adherencia al plan y la medición precisa de los resultados.

### 🏋️ Metodología de Entrenamiento
1. **Evaluación Inicial (Baseline):**
   - **Antropometría:** Registro detallado de peso, estatura y perímetros corporales (cuello, pecho, etc.).
   - **Test de Fuerza Relativa:** Establecimiento de marcas iniciales en los 4 levantamientos principales para calibrar el estado inicial del atleta.
2. **Ciclo de Entrenamiento (4 Semanas):**
   - Control diario por bloques de trabajo (Empuje, Tirón, Pierna).
   - Registro de métricas clave por serie: repeticiones reales, cargas ejecutadas ($kg$), volumen total y mejores series.
3. **Retest y Comparativa:**
   - Evaluación final tras el ciclo para contrastar la evolución.
   - Cálculo automático de ganancias en fuerza relativa y estimación de la mejora del $VO_2$ máx (basado en el Test de Cooper).

### 👥 Aspecto Social y Comunidad
- **Perfiles de Atleta:** Identidad única (`@usuario`), fotografía y nivel de cinturón visual (grados 0 a 4/6).
- **Feed de Entrenamiento:** Permite publicar resúmenes de sesiones finalizadas con series destacadas, volumen e impresiones personales.
- **Interacción:** Sistema de seguidores, *me gusta* y comentarios entre atletas para aumentar la motivación del equipo.

---

## 🛠️ Especificación Técnica y Arquitectura

### 🏗️ Arquitectura de la Aplicación
La aplicación sigue una arquitectura desacoplada y containerizada mediante **Docker**:

```text
 ┌────────────────┐       ┌─────────────────┐       ┌─────────────────┐
 │   Nginx Web    │ ────> │  Backend Node   │ ────> │ SQLite Storage  │
 │ (Frontend SPA) │       │ (Express + API) │       │ (/data/bjj.db)  │
 └────────────────┘       └─────────────────┘       └─────────────────┘
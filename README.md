# MisCuentas RD — Bot de Finanzas Personales

MisCuentas RD es una aplicación web progresiva (PWA) diseñada para ayudar a los usuarios a gestionar sus finanzas personales de manera sencilla e intuitiva. Permite registrar ingresos y gastos, categorizarlos, y visualizar un resumen de la situación financiera.

## Características

*   **Registro de Transacciones:** Añade fácilmente tus ingresos y gastos.
*   **Categorización:** Organiza tus transacciones por categorías personalizables.
*   **Visualización de Saldo:** Consulta tu saldo actual y el desglose de ingresos y gastos.
*   **Presupuestos:** Establece presupuestos para diferentes categorías y lleva un seguimiento de tu gasto.
*   **PWA:** Instala la aplicación en tu dispositivo móvil o escritorio para un acceso rápido.

## Instalación

Para configurar y ejecutar MisCuentas RD en tu entorno local, sigue estos pasos:

1.  **Clonar el repositorio:**

    ```bash
    git clone https://github.com/Stiwall/miscuentas-bot.git
    cd miscuentas-bot
    ```

2.  **Instalar dependencias:**

    ```bash
    npm install
    ```

3.  **Configurar la base de datos:**

    Este proyecto utiliza PostgreSQL. Asegúrate de tener un servidor PostgreSQL en funcionamiento. Puedes configurar las credenciales de la base de datos en un archivo de configuración (si existe) o directamente en `server.js`.

    Ejecuta el script `schema.sql` para crear las tablas necesarias:

    ```bash
    psql -U tu_usuario_postgres -d tu_base_de_datos -f schema.sql
    ```

4.  **Iniciar el servidor:**

    ```bash
    npm start
    ```

    La aplicación estará disponible en `http://localhost:3000` (o el puerto configurado).

## Uso

Una vez que la aplicación esté en funcionamiento, puedes acceder a ella a través de tu navegador web. Desde allí, podrás:

*   Navegar entre las diferentes secciones (Inicio, Transacciones, Presupuestos).
*   Añadir nuevas transacciones (ingresos o gastos).
*   Ver el resumen de tus finanzas.
*   Gestionar tus presupuestos.

## Contribución

¡Las contribuciones son bienvenidas! Si deseas mejorar este proyecto, por favor, haz un fork del repositorio y envía un pull request.

## Licencia

Este proyecto está bajo la Licencia MIT. Consulta el archivo `LICENSE` para más detalles.

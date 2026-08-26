uniform sampler2D u_Texture0;   // Diffuse
uniform sampler2D u_Texture1;	// Normal Map
uniform sampler2D u_Texture2;	// The reflection

varying vec2 texture_coordinate;

void main()
{
	
    // Sampling The Texture And Passing It To The Frame Buffer 
    gl_FragColor = texture2D(u_Texture0, texture_coordinate); 


	// TODO: Reflect!
}	